"""RCU AI Verification pipeline: ElevenLabs Scribe v2 → Multi-agent verification.

No LLM translation step — agents read code-mixed transcripts directly.
Pipeline stages:
  Stage 1: STT + Diarization (ElevenLabs Scribe v2)
  Stage 2: Multi-Agent Verification
    2a. Triage Agent (pre-flight — cheap, can short-circuit dead-simple calls)
    2b. 4 specialists in parallel: Information Extraction (auto-detects caller
        type), Identity Verification, Fraud Risk, Conversation Behavior
    2c. Decision Agent (Disposition Classifier — chain-of-thought)
    2d. Reflection Agent (self-critique — adjusts confidence / routing)

Granular cost tracking at the token + per-stage level.
"""
import os, json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from elevenlabs import ElevenLabs
from openai import AzureOpenAI

from prompts import (
    SPECIALIST_REGISTRY,
    SYS_SYNTHESIZER,
    SYS_TRIAGE,
    SYS_REFLECTION,
)

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
            kwargs["keyterms"] = cleaned[:1000]

    with open(audio_path, "rb") as f:
        resp = eleven_client.speech_to_text.convert(file=f, **kwargs)
    wall = time.time() - t0

    data = resp.model_dump() if hasattr(resp, "model_dump") else dict(resp.__dict__)
    duration_s = float(data.get("audio_duration_secs") or 0)
    duration_hr = duration_s / 3600

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


# ─── Word→Utterance grouping ────────────────────────────────────────────────
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


# ─── Agent runners ──────────────────────────────────────────────────────────
def _run_triage(client, deployment, transcript_for_prompt):
    user = (
        f"TRANSCRIPT (numbered, speaker-labeled, code-mixed Indian languages):\n\n"
        f"{transcript_for_prompt}\n\n"
        f"Apply the triage rules in strict order and return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, SYS_TRIAGE, user, max_tokens=500)
    return result, cost


def _run_specialist(client, deployment, name, transcript_for_prompt):
    spec = SPECIALIST_REGISTRY[name]
    user = (
        f"TRANSCRIPT (numbered, speaker-labeled, code-mixed Indian languages — read all scripts):\n\n"
        f"{transcript_for_prompt}\n\n"
        f"Analyze per your role and return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, spec["system"], user, spec["max_tokens"])
    return name, result, cost


def _compact_specialists_for_synthesis(specialist_results):
    """Strip bulky fields the Decision / Reflection agents don't need.

    The biggest offender is `per_utterance` (one entry per utt, ~600 tokens
    on long calls). Decision and Reflection already receive the transcript
    separately, so they don't need per-utterance tags re-passed — only the
    aggregate behavioural signals.
    """
    compact = {}
    for name, out in specialist_results.items():
        if not isinstance(out, dict):
            compact[name] = out
            continue
        # Shallow copy so we don't mutate the original
        c = dict(out)
        # Conversation behavior: drop per_utterance, keep aggregates
        if name == "conversation_behavior":
            c.pop("per_utterance", None)
        compact[name] = c
    return compact


def _run_synthesizer(client, deployment, transcript_for_prompt, specialist_results):
    body = _compact_specialists_for_synthesis(specialist_results)
    # Renumbered keys for readability in the prompt
    body_renamed = {
        "info_extraction":  body.get("information_extraction"),
        "identity":         body.get("identity_verification"),
        "fraud_risk":       body.get("fraud_risk"),
        "conversation":     body.get("conversation_behavior"),
    }
    # Compact JSON (no indent) saves significant whitespace tokens
    user = (
        f"TRANSCRIPT:\n{transcript_for_prompt}\n\n"
        f"SPECIALISTS:\n{json.dumps(body_renamed, ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"Apply chain-of-thought, disambiguation, and confidence caps. Return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, SYS_SYNTHESIZER, user, max_tokens=2500)
    return result, cost


def _run_reflection(client, deployment, transcript_for_prompt, specialist_results, decision_output):
    compact_specs = _compact_specialists_for_synthesis(specialist_results)
    body = {
        "specialists": compact_specs,
        "decision":    decision_output,
    }
    user = (
        f"TRANSCRIPT:\n{transcript_for_prompt}\n\n"
        f"PRIOR ANALYSIS:\n{json.dumps(body, ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"Critically review per the checklist. Return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, SYS_REFLECTION, user, max_tokens=1200)
    return result, cost


# ─── Disposition → RCU-status enforcement ───────────────────────────────────
# Canonical mapping (per Bajaj TC dispositions doc + prompts.py rubric).
# Lowercased keys for normalisation-tolerant lookup.
_CRITICAL_DISPOSITIONS = {
    "loan not taken",
    "loan cancelled",
    "call back suspicious",
    "third party attending calls",
    "wrong number",
    "vehicle delivered before login",
    "third party prompting on call",
    "refused to share information",
    "information mismatch-customer demographics",
    "information mismatch - customer demographics",
    "rented residing less than 1 year",
    "monnai name mismatch",
    "monnai name belongs to third party",
    "mobile number belongs to monnai",
    "tenure less than 3 months",
    "person is not co-applicant",
}
_NEGATIVE_DISPOSITIONS = {
    "third party attending calls (family-close blood relative)",
    "product mismatch",
    "refuse to share information- irate customer",
    "refuse to share information - irate customer",
    "dowry",
    "incomplete information",
    "third party use(family-close blood relative)",
    "third party use (family-close blood relative)",
    "third party mobile no(family-close blood relative)",
    "third party mobile no (family-close blood relative)",
    "refused to share information - dealer/sourcing influenced",
    "only enquiry",
    "connected but not response",
    "no negative information suspicious",
    "driver is not co-applicant",
    "call back",
}
_POSITIVE_DISPOSITIONS = {
    "no negative information",
}


def _status_for_disposition(disposition: Optional[str]) -> Optional[str]:
    if not disposition:
        return None
    key = disposition.strip().lower()
    if key in _CRITICAL_DISPOSITIONS:
        return "Critical"
    if key in _NEGATIVE_DISPOSITIONS:
        return "Negative"
    if key in _POSITIVE_DISPOSITIONS:
        return "Positive"
    return None


def _enforce_disposition_consistency(output: dict) -> dict:
    """If we recognise the disposition, force verdict + disposition_rcu_status \
    to the canonical mapping. The LLM occasionally picks the right disposition \
    but mis-tags it — this guard makes the routing decision deterministic."""
    if not isinstance(output, dict):
        return output
    status = _status_for_disposition(output.get("disposition"))
    if status is None:
        return output  # unknown disposition — trust the LLM
    out = dict(output)
    prior_status = out.get("disposition_rcu_status")
    prior_verdict = out.get("verdict")
    if prior_status != status:
        out["disposition_rcu_status"] = status
        out["_status_corrected_from"] = prior_status
    if prior_verdict != status:
        out["verdict"] = status
        out["_verdict_corrected_from"] = prior_verdict
    return out


# ─── Reflection application ─────────────────────────────────────────────────
_VALID_ROUTES = {"auto_clear", "human_qc", "compliance_escalation"}


def _apply_reflection(decision_output: dict, reflection_output: dict) -> dict:
    """Apply Reflection's adjustments to the Decision Agent output.
    Returns a NEW dict — does not mutate the original.
    """
    adjusted = dict(decision_output or {})
    if not isinstance(reflection_output, dict) or reflection_output.get("_parse_error"):
        return adjusted

    # 1) Confidence delta (clamped to 1..10)
    delta = reflection_output.get("confidence_delta")
    if isinstance(delta, (int, float)) and delta != 0:
        cur = adjusted.get("verdict_confidence_1_10")
        if isinstance(cur, (int, float)):
            new_conf = max(1, min(10, int(round(cur + delta))))
            adjusted["verdict_confidence_1_10"] = new_conf

    # 2) Routing override
    override = reflection_output.get("routing_override")
    if isinstance(override, str) and override in _VALID_ROUTES:
        cur_route = adjusted.get("decision_routing")
        if override != cur_route:
            adjusted["decision_routing"] = override
            prior_rationale = adjusted.get("routing_rationale") or ""
            adjusted["routing_rationale"] = (
                (prior_rationale + " | " if prior_rationale else "")
                + f"Reflection override → {override} ({reflection_output.get('reviewer_notes','')})".strip()
            )

    # 3) Disposition override suggestion — surface but DO NOT auto-mutate disposition.
    #    Reviewers see it; pipeline keeps the Decision Agent's pick to preserve auditability.
    sugg = reflection_output.get("disposition_override_suggestion")
    if isinstance(sugg, str) and sugg.strip() and sugg.strip().lower() != "null":
        adjusted["disposition_override_suggestion"] = sugg.strip()

    return adjusted


def _triage_to_decision_shape(triage_out: dict, audio_minutes: float) -> dict:
    """Expand a short-circuit triage result into the Decision Agent's output shape \
    so the rest of the pipeline / frontend keeps working unchanged."""
    disposition = triage_out.get("quick_disposition")
    # Derive verdict from disposition (LLM occasionally omits quick_verdict)
    derived_status = _status_for_disposition(disposition)
    verdict = triage_out.get("quick_verdict") or derived_status or "Negative"
    status = derived_status or verdict
    return {
        "reasoning_chain": [
            f"Triage short-circuit: {triage_out.get('rationale','(no rationale)')}",
        ],
        "verdict": verdict,
        "verdict_confidence_1_10": triage_out.get("quick_confidence_1_10") or 7,
        "disposition": disposition,
        "disposition_rcu_status": status,
        "caller_type": "Unknown",
        "executive_summary": (
            f"Triage short-circuit ({audio_minutes:.2f} min audio). "
            f"{triage_out.get('rationale','')}"
        ).strip(),
        "rationale": triage_out.get("rationale", ""),
        "key_evidence_quotes": [],
        "risk_tags": [],
        "decision_routing": triage_out.get("quick_routing") or "human_qc",
        "routing_rationale": "Disposed by Triage Agent — no full pipeline needed.",
        "headline_chip": disposition or "Triaged",
        "_triage_short_circuit": True,
    }


# ─── Orchestrator ───────────────────────────────────────────────────────────
def run_multi_agent_verification(llm_client, deployment, utterances, max_workers=5, audio_minutes: float = 0.0):
    """Triage → 4 RCU specialists in parallel → Decision Agent → Reflection.

    If Triage short-circuits, specialists/decision/reflection are skipped.
    """
    transcript_for_prompt = _format_transcript_for_prompt(utterances)
    t_overall = time.time()

    # 2a. TRIAGE ----------------------------------------------------------------
    t_triage = time.time()
    triage_out, triage_cost = _run_triage(llm_client, deployment, transcript_for_prompt)
    t_triage_elapsed = time.time() - t_triage

    needs_full = bool(triage_out.get("needs_full_pipeline", True))  # default to full if missing
    triage_short_circuit = (not needs_full) and triage_out.get("quick_disposition")

    if triage_short_circuit:
        # Build a Decision-Agent-shaped object so downstream code is unchanged.
        synth_out = _triage_to_decision_shape(triage_out, audio_minutes)
        synth_cost = {
            "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
            "cost_usd_input": 0.0, "cost_usd_output": 0.0, "cost_usd_total": 0.0,
            "wall_time_s": 0.0,
        }
        reflection_out, reflection_cost = None, {
            "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
            "cost_usd_input": 0.0, "cost_usd_output": 0.0, "cost_usd_total": 0.0,
            "wall_time_s": 0.0,
        }

        total_in  = triage_cost["prompt_tokens"]
        total_out = triage_cost["completion_tokens"]
        total_usd = triage_cost["cost_usd_total"]

        return {
            "triage": {"output": triage_out, "cost": triage_cost, "short_circuited": True},
            "specialists": {},
            "decision_agent": {"output": synth_out, "cost": synth_cost},
            "reflection": {"output": reflection_out, "cost": reflection_cost, "applied": False},
            "final_output": synth_out,
            "aggregate_cost": {
                "total_prompt_tokens":     total_in,
                "total_completion_tokens": total_out,
                "total_tokens":            total_in + total_out,
                "total_cost_usd":          round(total_usd, 8),
                "triage_usd":              triage_cost["cost_usd_total"],
                "specialists_total_usd":   0.0,
                "decision_agent_usd":      0.0,
                "reflection_usd":          0.0,
                "n_specialists":           0,
            },
            "timing": {
                "triage_wall_s":               round(t_triage_elapsed, 2),
                "specialists_parallel_wall_s": 0.0,
                "decision_agent_wall_s":       0.0,
                "reflection_wall_s":           0.0,
                "total_verification_wall_s":   round(time.time() - t_overall, 2),
            },
            "ran_at_utc": datetime.now(timezone.utc).isoformat(),
            "model": deployment,
        }

    # 2b. SPECIALISTS IN PARALLEL ------------------------------------------------
    spec_results: Dict[str, Any] = {}
    spec_costs:   Dict[str, Any] = {}
    t_spec = time.time()
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = [ex.submit(_run_specialist, llm_client, deployment, n, transcript_for_prompt)
                   for n in SPECIALIST_REGISTRY]
        for fut in as_completed(futures):
            n, out, cost = fut.result()
            spec_results[n] = out
            spec_costs[n]   = cost
    t_spec_elapsed = time.time() - t_spec

    # 2c. DECISION AGENT ---------------------------------------------------------
    t_synth = time.time()
    synth_out, synth_cost = _run_synthesizer(llm_client, deployment, transcript_for_prompt, spec_results)
    # Server-side enforcement: lock verdict + status to the canonical mapping
    # for the chosen disposition. LLM occasionally drifts these out of sync.
    synth_out = _enforce_disposition_consistency(synth_out)
    t_synth_elapsed = time.time() - t_synth

    # 2d. REFLECTION -------------------------------------------------------------
    t_refl = time.time()
    reflection_out, reflection_cost = _run_reflection(
        llm_client, deployment, transcript_for_prompt, spec_results, synth_out
    )
    t_refl_elapsed = time.time() - t_refl

    final_output = _enforce_disposition_consistency(_apply_reflection(synth_out, reflection_out))
    reflection_applied = (
        isinstance(reflection_out, dict)
        and not reflection_out.get("_parse_error")
        and (
            (reflection_out.get("confidence_delta") or 0) != 0
            or reflection_out.get("routing_override")
            or reflection_out.get("disposition_override_suggestion")
        )
    )

    total_in  = (
        triage_cost["prompt_tokens"]
        + sum(c["prompt_tokens"] for c in spec_costs.values())
        + synth_cost["prompt_tokens"]
        + reflection_cost["prompt_tokens"]
    )
    total_out = (
        triage_cost["completion_tokens"]
        + sum(c["completion_tokens"] for c in spec_costs.values())
        + synth_cost["completion_tokens"]
        + reflection_cost["completion_tokens"]
    )
    total_usd = (
        triage_cost["cost_usd_total"]
        + sum(c["cost_usd_total"] for c in spec_costs.values())
        + synth_cost["cost_usd_total"]
        + reflection_cost["cost_usd_total"]
    )

    return {
        "triage": {"output": triage_out, "cost": triage_cost, "short_circuited": False},
        "specialists": {
            name: {"output": spec_results[name], "cost": spec_costs[name]}
            for name in SPECIALIST_REGISTRY
        },
        "decision_agent": {"output": synth_out, "cost": synth_cost},
        "reflection": {
            "output": reflection_out,
            "cost": reflection_cost,
            "applied": bool(reflection_applied),
        },
        "final_output": final_output,
        "aggregate_cost": {
            "total_prompt_tokens":     total_in,
            "total_completion_tokens": total_out,
            "total_tokens":            total_in + total_out,
            "total_cost_usd":          round(total_usd, 8),
            "triage_usd":              triage_cost["cost_usd_total"],
            "specialists_total_usd":   round(sum(c["cost_usd_total"] for c in spec_costs.values()), 8),
            "decision_agent_usd":      synth_cost["cost_usd_total"],
            "reflection_usd":          reflection_cost["cost_usd_total"],
            "n_specialists":           len(spec_costs),
        },
        "timing": {
            "triage_wall_s":               round(t_triage_elapsed, 2),
            "specialists_parallel_wall_s": round(t_spec_elapsed, 2),
            "decision_agent_wall_s":       round(t_synth_elapsed, 2),
            "reflection_wall_s":           round(t_refl_elapsed, 2),
            "total_verification_wall_s":   round(time.time() - t_overall, 2),
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
    """One call → STT (Scribe v2) → Multi-agent verification. Returns unified record."""
    t_call = time.time()

    # Stage 1: STT
    stt_data, stt_cost = transcribe_with_scribe_v2(audio_path, eleven_client, keyterms=keyterms)
    utterances = group_words_into_utterances(stt_data.get("words") or [])
    if not utterances:
        raise RuntimeError("No utterances detected after STT (silent/empty audio?)")

    speakers = sorted({u["speaker"] for u in utterances if u.get("speaker")})

    # Stage 2: Multi-agent RCU verification (Triage → specialists → Decision → Reflection)
    verification = run_multi_agent_verification(
        llm_client, llm_deployment, utterances,
        audio_minutes=stt_cost["audio_minutes"],
    )

    # Use the post-reflection final output for the top-level surface
    final_output = verification.get("final_output") or verification.get("decision_agent", {}).get("output", {}) or {}
    decision_raw = verification.get("decision_agent", {}).get("output", {}) or {}
    reflection_block = verification.get("reflection") or {}

    # Unified cost summary
    total_cost = stt_cost["cost_usd_total"] + verification["aggregate_cost"]["total_cost_usd"]
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
        # Top-level RCU verdict surface — reflects POST-REFLECTION final output.
        "rcu_verdict": {
            "verdict":                 final_output.get("verdict"),
            "verdict_confidence_1_10": final_output.get("verdict_confidence_1_10"),
            "disposition":             final_output.get("disposition"),
            "disposition_rcu_status":  final_output.get("disposition_rcu_status"),
            "caller_type":             final_output.get("caller_type"),
            "decision_routing":        final_output.get("decision_routing"),
            "routing_rationale":       final_output.get("routing_rationale"),
            "headline_chip":           final_output.get("headline_chip"),
            "executive_summary":       final_output.get("executive_summary"),
            "rationale":               final_output.get("rationale"),
            "risk_tags":               final_output.get("risk_tags", []),
            "key_evidence_quotes":     final_output.get("key_evidence_quotes", []),
            "reasoning_chain":         final_output.get("reasoning_chain", []),
            "disposition_override_suggestion": final_output.get("disposition_override_suggestion"),
            # Provenance flags so the UI can show "Triaged" or "Reflection adjusted"
            "triage_short_circuit": bool(final_output.get("_triage_short_circuit", False)),
            "reflection_applied":   bool(reflection_block.get("applied", False)),
            # Raw pre-reflection verdict (so reviewers can see the delta)
            "pre_reflection": {
                "verdict_confidence_1_10": decision_raw.get("verdict_confidence_1_10"),
                "decision_routing":        decision_raw.get("decision_routing"),
            } if reflection_block.get("applied") else None,
        },
        "stage_1_stt": {
            "vendor": "ElevenLabs Scribe v2",
            "model_id": "scribe_v2",
            "raw_full_text": stt_data.get("text"),
            "utterances": utterances,
            "cost": stt_cost,
        },
        "stage_2_verification": verification,
        "unified_cost": {
            "stt_usd":            stt_cost["cost_usd_total"],
            "verification_usd":   verification["aggregate_cost"]["total_cost_usd"],
            "triage_usd":         verification["aggregate_cost"].get("triage_usd", 0.0),
            "specialists_usd":    verification["aggregate_cost"]["specialists_total_usd"],
            "decision_agent_usd": verification["aggregate_cost"]["decision_agent_usd"],
            "reflection_usd":     verification["aggregate_cost"].get("reflection_usd", 0.0),
            "total_usd":          round(total_cost, 8),
            "cost_per_minute_audio_usd": round(cost_per_min, 8) if cost_per_min is not None else None,
            "total_wall_time_s":  round(time.time() - t_call, 2),
            "stage_cost_share_pct": {
                "stt":          round(100 * stt_cost["cost_usd_total"]                       / max(total_cost, 1e-9), 2),
                "verification": round(100 * verification["aggregate_cost"]["total_cost_usd"] / max(total_cost, 1e-9), 2),
            },
            "rate_card": RATE_CARD,
        },
    }
