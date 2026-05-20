"""Call analysis pipeline: ElevenLabs Scribe v2 → Multi-agent sentiment.

No LLM translation step — agents read code-mixed transcripts directly.
Granular cost tracking at the token + per-stage level.
"""
import os, json, time, traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from elevenlabs import ElevenLabs
from openai import AzureOpenAI

from prompts import SPECIALIST_REGISTRY, SYS_SYNTHESIZER

# ─── Pricing (verified May 2026, USD per unit) ─────────────────────────────
RATE_CARD = {
    "elevenlabs_scribe_v2_base_per_hour":         0.22,
    "elevenlabs_keyterms_surcharge_per_hour":     0.05,
    "elevenlabs_entity_detection_surcharge_per_hour": 0.07,
    "elevenlabs_detect_speaker_roles_pct":        0.10,   # +10% of base
    "azure_gpt4o_mini_per_M_input_usd":           0.20,
    "azure_gpt4o_mini_per_M_output_usd":          0.60,
}


# ─── ElevenLabs Scribe v2 STT ───────────────────────────────────────────────
def transcribe_with_scribe_v2(
    audio_path: str,
    eleven_client: ElevenLabs,
    keyterms: Optional[List[str]] = None,
):
    """Run Scribe v2 with diarization on the audio file.
    Returns (data_dict, cost_dict). Raises on API failure.
    """
    t0 = time.time()
    kwargs: Dict[str, Any] = {
        "model_id": "scribe_v2",
        "diarize": True,
        "timestamps_granularity": "word",
        "tag_audio_events": False,
    }
    if keyterms:
        cleaned = [k.strip() for k in keyterms if k and k.strip()]
        if cleaned:
            kwargs["keyterms"] = cleaned[:1000]  # API hard limit

    with open(audio_path, "rb") as f:
        resp = eleven_client.speech_to_text.convert(file=f, **kwargs)
    wall = time.time() - t0

    data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp.__dict__)
    duration_s = float(data.get("audio_duration_secs") or 0)
    duration_hr = duration_s / 3600

    # Cost computation (verified line items from elevenlabs.io/pricing/api)
    base_cost = duration_hr * RATE_CARD["elevenlabs_scribe_v2_base_per_hour"]
    keyterms_cost = (
        duration_hr * RATE_CARD["elevenlabs_keyterms_surcharge_per_hour"]
        if kwargs.get("keyterms")
        else 0.0
    )
    total_cost = base_cost + keyterms_cost

    cost = {
        "audio_seconds": round(duration_s, 3),
        "audio_minutes": round(duration_s / 60, 4),
        "audio_hours":   round(duration_hr, 6),
        "rate_per_hour_base":     RATE_CARD["elevenlabs_scribe_v2_base_per_hour"],
        "rate_per_hour_keyterms": RATE_CARD["elevenlabs_keyterms_surcharge_per_hour"] if kwargs.get("keyterms") else 0.0,
        "rate_per_hour_total":    RATE_CARD["elevenlabs_scribe_v2_base_per_hour"] + (
            RATE_CARD["elevenlabs_keyterms_surcharge_per_hour"] if kwargs.get("keyterms") else 0.0
        ),
        "cost_usd_base":     round(base_cost, 8),
        "cost_usd_keyterms": round(keyterms_cost, 8),
        "cost_usd_total":    round(total_cost, 8),
        "keyterms_used":     kwargs.get("keyterms", []),
        "wall_time_s":       round(wall, 2),
    }
    return data, cost


# ─── Word→Utterance grouping (Scribe v2 returns word-level; we want turns) ──
def group_words_into_utterances(words):
    utts = []
    cur_speaker = None
    cur_text: List[str] = []
    cur_start: Optional[float] = None
    cur_end: Optional[float] = None
    for w in (words or []):
        if w.get("type") == "audio_event":
            continue
        spk = w.get("speaker_id")
        text = w.get("text") or ""
        if spk != cur_speaker and cur_speaker is not None:
            joined = "".join(cur_text).strip()
            if joined:
                utts.append({
                    "speaker": cur_speaker,
                    "text": joined,
                    "start_s": cur_start,
                    "end_s": cur_end,
                })
            cur_text = []
            cur_start = None
        cur_speaker = spk
        if cur_start is None:
            cur_start = w.get("start")
        cur_end = w.get("end")
        cur_text.append(text)
    if cur_text:
        joined = "".join(cur_text).strip()
        if joined:
            utts.append({
                "speaker": cur_speaker,
                "text": joined,
                "start_s": cur_start,
                "end_s": cur_end,
            })
    return utts


# ─── LLM call helpers ───────────────────────────────────────────────────────
def _strip_md_fences(content):
    content = (content or "").strip()
    if content.startswith("```"):
        content = content.strip("`")
        if content.lower().startswith("json"):
            content = content[4:]
        content = content.strip()
    return content


def _safe_parse(content):
    try:
        return json.loads(_strip_md_fences(content))
    except Exception as e:
        return {"_parse_error": str(e), "_raw": (content or "")[:500]}


def _llm_cost(usage):
    cin  = usage.prompt_tokens / 1_000_000 * RATE_CARD["azure_gpt4o_mini_per_M_input_usd"]
    cout = usage.completion_tokens / 1_000_000 * RATE_CARD["azure_gpt4o_mini_per_M_output_usd"]
    return {
        "prompt_tokens":     usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_tokens":      usage.prompt_tokens + usage.completion_tokens,
        "cost_usd_input":   round(cin, 8),
        "cost_usd_output":  round(cout, 8),
        "cost_usd_total":   round(cin + cout, 8),
    }


def _call_llm(client, deployment, system_prompt, user_prompt, max_tokens):
    t0 = time.time()
    resp = client.chat.completions.create(
        model=deployment,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        temperature=0.2,
        response_format={"type": "json_object"},
        max_completion_tokens=max_tokens,
    )
    wall = time.time() - t0
    parsed = _safe_parse(resp.choices[0].message.content)
    cost = _llm_cost(resp.usage)
    cost["wall_time_s"] = round(wall, 2)
    return parsed, cost


def _format_transcript_for_prompt(utterances):
    lines = []
    for i, u in enumerate(utterances):
        t = u.get("start_s") or 0
        mm, ss = divmod(int(t), 60)
        ts = f"[{mm:02d}:{ss:02d}]"
        lines.append(f'{i}: {ts} Speaker {u.get("speaker")}: {u.get("text")}')
    return "\n".join(lines)


def _run_specialist(client, deployment, name, transcript_for_prompt):
    spec = SPECIALIST_REGISTRY[name]
    user = (
        f"TRANSCRIPT (numbered, speaker-labeled, code-mixed Indian languages — read all scripts):\n\n"
        f"{transcript_for_prompt}\n\n"
        f"Analyze per your role and return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, spec["system"], user, spec["max_tokens"])
    return name, result, cost


def _run_synthesizer(client, deployment, transcript_for_prompt, specialist_results):
    body = {
        "specialist_1_call_intelligence":  specialist_results["intelligence"],
        "specialist_2_emotion_tonality":   specialist_results["emotion"],
        "specialist_3_agent_performance":  specialist_results["performance"],
        "specialist_4_resolution_pain":    specialist_results["resolution"],
        "specialist_5_risk_compliance":    specialist_results["risk"],
    }
    user = (
        f"TRANSCRIPT (code-mixed Indian languages):\n\n{transcript_for_prompt}\n\n"
        f"SPECIALIST REPORTS:\n\n{json.dumps(body, ensure_ascii=False, indent=2)}\n\n"
        f"Synthesize per your role and return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, SYS_SYNTHESIZER, user, max_tokens=2500)
    return result, cost


def run_multi_agent_sentiment(llm_client, deployment, utterances, max_workers=5):
    """5 specialists in parallel + 1 synthesizer (sequential)."""
    transcript_for_prompt = _format_transcript_for_prompt(utterances)
    t_overall = time.time()

    spec_results = {}
    spec_costs   = {}
    t_spec = time.time()
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = [ex.submit(_run_specialist, llm_client, deployment, n, transcript_for_prompt)
                   for n in SPECIALIST_REGISTRY]
        for fut in as_completed(futures):
            n, out, cost = fut.result()
            spec_results[n] = out
            spec_costs[n]   = cost
    t_spec_elapsed = time.time() - t_spec

    t_synth = time.time()
    synth_out, synth_cost = _run_synthesizer(llm_client, deployment, transcript_for_prompt, spec_results)
    t_synth_elapsed = time.time() - t_synth

    total_in  = sum(c["prompt_tokens"]     for c in spec_costs.values()) + synth_cost["prompt_tokens"]
    total_out = sum(c["completion_tokens"] for c in spec_costs.values()) + synth_cost["completion_tokens"]
    total_usd = sum(c["cost_usd_total"]    for c in spec_costs.values()) + synth_cost["cost_usd_total"]

    return {
        "specialists": {
            name: {"output": spec_results[name], "cost": spec_costs[name]}
            for name in SPECIALIST_REGISTRY
        },
        "synthesizer": {"output": synth_out, "cost": synth_cost},
        "aggregate_cost": {
            "total_prompt_tokens":     total_in,
            "total_completion_tokens": total_out,
            "total_tokens":            total_in + total_out,
            "total_cost_usd":          round(total_usd, 8),
            "specialists_total_usd":   round(sum(c["cost_usd_total"] for c in spec_costs.values()), 8),
            "synthesizer_usd":         synth_cost["cost_usd_total"],
            "n_specialists":           len(spec_costs),
        },
        "timing": {
            "specialists_parallel_wall_s": round(t_spec_elapsed, 2),
            "synthesizer_wall_s":          round(t_synth_elapsed, 2),
            "total_sentiment_wall_s":      round(time.time() - t_overall, 2),
        },
        "ran_at_utc": datetime.now(timezone.utc).isoformat(),
        "model": deployment,
    }


# ─── Full pipeline orchestrator ─────────────────────────────────────────────
def analyze_call_end_to_end(
    audio_path: str,
    eleven_client: ElevenLabs,
    llm_client: AzureOpenAI,
    llm_deployment: str,
    keyterms: Optional[List[str]] = None,
):
    """One call → STT (Scribe v2) → Multi-agent sentiment. Returns unified record."""
    t_call = time.time()

    # Stage 1: STT
    stt_data, stt_cost = transcribe_with_scribe_v2(audio_path, eleven_client, keyterms=keyterms)
    utterances = group_words_into_utterances(stt_data.get("words") or [])
    if not utterances:
        raise RuntimeError("No utterances detected after STT (silent/empty audio?)")

    speakers = sorted({u["speaker"] for u in utterances if u.get("speaker")})

    # Stage 2: Multi-agent sentiment (code-mix aware, no translation step)
    sentiment = run_multi_agent_sentiment(llm_client, llm_deployment, utterances)

    # Unified cost summary
    total_cost = stt_cost["cost_usd_total"] + sentiment["aggregate_cost"]["total_cost_usd"]
    audio_minutes = stt_cost["audio_minutes"]
    cost_per_min = total_cost / max(audio_minutes, 1e-9) if audio_minutes > 0 else None

    return {
        "filename": os.path.basename(audio_path),
        "processed_at_utc": datetime.now(timezone.utc).isoformat(),
        "audio_meta": {
            "audio_duration_s": stt_cost["audio_seconds"],
            "audio_minutes":    audio_minutes,
            "language_code":    stt_data.get("language_code"),
            "language_probability": stt_data.get("language_probability"),
            "num_speakers":     len(speakers),
            "num_utterances":   len(utterances),
            "transcription_id": stt_data.get("transcription_id"),
            "keyterms_applied": keyterms or [],
        },
        "stage_1_stt": {
            "vendor": "ElevenLabs Scribe v2",
            "model_id": "scribe_v2",
            "raw_full_text": stt_data.get("text"),
            "utterances": utterances,
            "cost": stt_cost,
        },
        "stage_2_sentiment_multi_agent": sentiment,
        "unified_cost": {
            "stt_usd":         stt_cost["cost_usd_total"],
            "sentiment_usd":   sentiment["aggregate_cost"]["total_cost_usd"],
            "specialists_usd": sentiment["aggregate_cost"]["specialists_total_usd"],
            "synthesizer_usd": sentiment["aggregate_cost"]["synthesizer_usd"],
            "total_usd":       round(total_cost, 8),
            "cost_per_minute_audio_usd": round(cost_per_min, 8) if cost_per_min is not None else None,
            "total_wall_time_s": round(time.time() - t_call, 2),
            "stage_cost_share_pct": {
                "stt":       round(100 * stt_cost["cost_usd_total"]                / max(total_cost, 1e-9), 2),
                "sentiment": round(100 * sentiment["aggregate_cost"]["total_cost_usd"] / max(total_cost, 1e-9), 2),
            },
            "rate_card": RATE_CARD,
        },
    }
