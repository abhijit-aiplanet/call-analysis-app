"""RCU AI Verification pipeline: Soniox stt-async-v4 → Multi-agent verification.

(ElevenLabs Scribe v2 retained as a fallback — toggle with STT_PROVIDER env var.)

No LLM translation step — agents read code-mixed transcripts directly.
Pipeline stages:
  Stage 1: STT + Diarization (Soniox stt-async-v4 default; ElevenLabs fallback)
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

import requests
from elevenlabs import ElevenLabs
from openai import AzureOpenAI

# Structured JSONL audit logger — captures every STT request, LLM call,
# disposition decision, and post-hoc rule firing for offline analysis.
# Disable with AUDIT_LOG_DISABLED=1; otherwise on by default.
import audit_log

from prompts import (
    SPECIALIST_REGISTRY,
    SYS_SYNTHESIZER,
    SYS_TRIAGE,
    SYS_REFLECTION,
)

# ─── Pricing (verified May 2026, USD per unit) ─────────────────────────────
RATE_CARD = {
    "soniox_stt_async_v4_per_hour":               0.10,   # Soniox $0.10/hr async
    "elevenlabs_scribe_v2_base_per_hour":         0.22,
    "elevenlabs_keyterms_surcharge_per_hour":     0.05,
    "elevenlabs_entity_detection_surcharge_per_hour": 0.07,
    "elevenlabs_detect_speaker_roles_pct":        0.10,   # +10% of base
    "azure_gpt4o_mini_per_M_input_usd":           0.20,
    "azure_gpt4o_mini_per_M_output_usd":          0.60,
}


# ─── Soniox configuration ──────────────────────────────────────────────────
SONIOX_BASE = "https://api.soniox.com"
# These read from env at call time (not import time) so they pick up dotenv
# even if api.py loads .env after importing pipeline.
def _soniox_api_key() -> str:
    return os.environ.get("SONIOX_API_KEY", "")
def _stt_provider() -> str:
    return os.environ.get("STT_PROVIDER", "soniox").lower()
# Module-level aliases (for backward compat with code that reads them once)
SONIOX_API_KEY = _soniox_api_key()
STT_PROVIDER   = _stt_provider()

# Indian-language hints — passed to stt-async-v4 to significantly improve
# accuracy on BACL RCU calls (per Soniox docs). Hints cover all 6 major
# Indian languages we see in the test set + English code-mixing.
SONIOX_LANGUAGE_HINTS = ["hi", "mr", "te", "ta", "ml", "kn", "gu", "bn", "en"]

# Domain context (up to 8K tokens, free). Lifted from RCU_Context vocabulary +
# the model's DOMAIN_CORE. Helps Soniox correctly transcribe Bajaj-specific
# terms (model names, vehicle types, RCU jargon) instead of guessing.
SONIOX_CONTEXT_RCU: Dict[str, Any] = {
    "general": [
        {"key": "domain",       "value": "Loan application verification call"},
        {"key": "organization", "value": "Bajaj Auto Credit Limited (BACL)"},
        {"key": "department",   "value": "Risk Containment Unit (RCU)"},
        {"key": "country",      "value": "India"},
        {"key": "purpose",      "value": "Telephonic Confirmation (TC) before disbursement"},
    ],
    "text": (
        "This is a pre-disbursement verification call from BACL's RCU team. "
        "The agent verifies the applicant's identity, address, mobile-number "
        "ownership, vehicle details, and loan purpose. Speakers code-mix "
        "between Hindi/Marathi/Telugu/Tamil/Malayalam/Kannada/Gujarati/Bengali "
        "and English. Domain terms (Bajaj, EMI, OTP, finance, sanction letter, "
        "co-applicant, guarantor) often appear in English even when the rest "
        "of the speech is in a regional language."
    ),
    "terms": [
        # Org / product
        "Bajaj", "Bajaj Auto Credit", "BACL", "RCU", "Monnai",
        # Process
        "EMI", "OTP", "ROI", "DP", "Aadhaar", "PAN", "KYC",
        "sanction letter", "disbursal", "disbursement", "foreclosure",
        "refinance", "login date", "two-wheeler", "three-wheeler",
        "co-applicant", "guarantor", "applicant",
        # Vehicle models / brands seen in test set
        "Pulsar", "Yamaha", "NS 160", "FZ", "Splendor", "Activa",
        "Pulsar 150", "Pulsar 220", "Bajaj auto rickshaw",
        "Hero", "Honda", "TVS",
        # Indian-language verification phrases (Hindi/Marathi)
        "finance", "verification", "address", "showroom",
    ],
}


# ─── Soniox stt-async-v4 STT (primary) ─────────────────────────────────────
def transcribe_with_soniox(
    audio_path: str,
    keyterms: Optional[List[str]] = None,
):
    """Run Soniox stt-async-v4 (file upload → transcribe → poll → fetch → cleanup).

    Returns (data_dict, cost_dict) with the same shape as transcribe_with_scribe_v2
    so the rest of the pipeline (utterance grouping, cost rollup) is unchanged.

    Uses every meaningful accuracy lever from the API:
      - language_hints (Indian languages + English code-mixing)
      - enable_speaker_diarization (3+ speakers handled natively)
      - enable_language_identification (per-token language tag)
      - context.general / context.text / context.terms (BACL/RCU vocab + user
        keyterms appended) for domain accuracy
    Translation, webhooks, and language_hints_strict are intentionally OFF —
    we want auto-detection and our LLMs handle code-mixed transcripts directly.
    """
    api_key = _soniox_api_key()
    if not api_key:
        raise RuntimeError("SONIOX_API_KEY is not set in the environment.")

    sess = requests.Session()
    sess.headers["Authorization"] = f"Bearer {api_key}"
    t0 = time.time()

    # Merge user-provided keyterms into our standing RCU context.terms list
    context = json.loads(json.dumps(SONIOX_CONTEXT_RCU))  # deep copy
    if keyterms:
        extra = [k.strip() for k in keyterms if k and k.strip()]
        if extra:
            context["terms"] = list(dict.fromkeys((context.get("terms") or []) + extra))

    # 1. Upload audio file
    with open(audio_path, "rb") as f:
        up = sess.post(f"{SONIOX_BASE}/v1/files", files={"file": f}, timeout=180)
    if not up.ok:
        raise RuntimeError(f"Soniox upload failed: {up.status_code} {up.text[:300]}")
    file_id = up.json()["id"]

    # 2. Create transcription job
    body = {
        "model": "stt-async-v4",
        "file_id": file_id,
        "language_hints": SONIOX_LANGUAGE_HINTS,
        "enable_speaker_diarization": True,
        "enable_language_identification": True,
        "context": context,
        "client_reference_id": os.path.basename(audio_path)[:255],
    }
    tx = sess.post(f"{SONIOX_BASE}/v1/transcriptions", json=body, timeout=30)
    if not tx.ok:
        raise RuntimeError(f"Soniox transcribe-create failed: {tx.status_code} {tx.text[:300]}")
    transcription_id = tx.json()["id"]

    # 3. Poll for completion
    poll_deadline = time.time() + 600  # 10 min cap
    while True:
        if time.time() > poll_deadline:
            raise RuntimeError(f"Soniox transcription timed out (id={transcription_id})")
        st = sess.get(f"{SONIOX_BASE}/v1/transcriptions/{transcription_id}", timeout=30)
        if not st.ok:
            raise RuntimeError(f"Soniox poll failed: {st.status_code} {st.text[:300]}")
        status = st.json().get("status")
        if status == "completed":
            break
        if status == "error":
            raise RuntimeError(f"Soniox transcription errored: {st.json()}")
        time.sleep(1.5)

    # 4. Fetch transcript
    tr = sess.get(f"{SONIOX_BASE}/v1/transcriptions/{transcription_id}/transcript", timeout=60)
    if not tr.ok:
        raise RuntimeError(f"Soniox transcript fetch failed: {tr.status_code} {tr.text[:300]}")
    transcript = tr.json()
    wall = time.time() - t0

    # 5. Cleanup (best effort — don't fail the job if cleanup fails)
    try:
        sess.delete(f"{SONIOX_BASE}/v1/transcriptions/{transcription_id}", timeout=15)
        sess.delete(f"{SONIOX_BASE}/v1/files/{file_id}", timeout=15)
    except Exception:
        pass

    tokens = transcript.get("tokens") or []
    duration_s = (max((t.get("end_ms") or 0) for t in tokens) / 1000.0) if tokens else 0.0
    duration_hr = duration_s / 3600

    # Pick the most-common language across tokens (mirrors ElevenLabs' single language_code field)
    lang_counts: Dict[str, int] = {}
    for t in tokens:
        l = t.get("language")
        if l:
            lang_counts[l] = lang_counts.get(l, 0) + 1
    dominant_lang = max(lang_counts, key=lang_counts.get) if lang_counts else None
    # Probability proxy: dominant tokens / total tokens with any language assigned
    lang_prob = lang_counts.get(dominant_lang, 0) / max(sum(lang_counts.values()), 1) if dominant_lang else None

    # Normalised data dict (matches ElevenLabs' shape so downstream code is unchanged)
    data = {
        "text": transcript.get("text"),
        "language_code": dominant_lang,
        "language_probability": lang_prob,
        "audio_duration_secs": duration_s,
        "transcription_id": transcription_id,
        "words": [
            # Convert Soniox token → ElevenLabs-style word
            {
                "type": "word" if not tok.get("is_audio_event") else "audio_event",
                "text": tok.get("text") or "",
                "speaker_id": (f"speaker_{tok.get('speaker')}" if tok.get("speaker") is not None else None),
                "start": (tok.get("start_ms") or 0) / 1000.0,
                "end":   (tok.get("end_ms") or 0) / 1000.0,
                "confidence": tok.get("confidence"),
                "language": tok.get("language"),
            }
            for tok in tokens
        ],
        # Keep the raw response for audit/debugging
        "soniox_raw": transcript,
    }

    base_cost = duration_hr * RATE_CARD["soniox_stt_async_v4_per_hour"]
    cost = {
        "audio_seconds": round(duration_s, 3),
        "audio_minutes": round(duration_s / 60, 4),
        "audio_hours":   round(duration_hr, 6),
        "rate_per_hour_base":     RATE_CARD["soniox_stt_async_v4_per_hour"],
        "rate_per_hour_keyterms": 0.0,
        "rate_per_hour_total":    RATE_CARD["soniox_stt_async_v4_per_hour"],
        "cost_usd_base":     round(base_cost, 8),
        "cost_usd_keyterms": 0.0,
        "cost_usd_total":    round(base_cost, 8),
        "keyterms_used":     keyterms or [],
        "wall_time_s":       round(wall, 2),
        "provider":          "soniox_stt_async_v4",
    }
    jid, fn = _audit_ctx_get()
    audit_log.log_stt_call(
        job_id=jid, filename=fn, provider="soniox_stt_async_v4",
        audio_duration_s=duration_s,
        language_code=dominant_lang,
        language_probability=lang_prob,
        num_words=len(tokens),
        num_speakers=len({tok.get("speaker") for tok in tokens if tok.get("speaker") is not None}),
        cost_usd_total=cost["cost_usd_total"], wall_time_s=cost["wall_time_s"],
    )
    return data, cost


def transcribe_stt(
    audio_path: str,
    eleven_client: Optional[ElevenLabs],
    keyterms: Optional[List[str]] = None,
):
    """Router — dispatches to the active STT provider based on STT_PROVIDER env var.
    Defaults to Soniox (cheaper + better Indian-language support per our 5-call benchmark).
    Falls back to ElevenLabs Scribe v2 if STT_PROVIDER=elevenlabs.
    """
    provider = _stt_provider()
    if provider == "elevenlabs":
        if eleven_client is None:
            raise RuntimeError("STT_PROVIDER=elevenlabs but no ElevenLabs client provided.")
        return transcribe_with_scribe_v2(audio_path, eleven_client, keyterms=keyterms)
    # Default: Soniox
    return transcribe_with_soniox(audio_path, keyterms=keyterms)


# ─── ElevenLabs Scribe v2 STT (fallback, kept for parity) ──────────────────
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
        "provider":          "elevenlabs_scribe_v2",
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


# Thread-local audit context — set per-file by the orchestrator and read by
# the agent runners (which need to know which job/file each LLM call belongs
# to without us threading it through every signature).
import threading as _threading
_audit_ctx = _threading.local()


def _set_audit_ctx(job_id: Optional[str], filename: Optional[str]) -> None:
    _audit_ctx.job_id = job_id
    _audit_ctx.filename = filename


def _audit_ctx_get():
    return getattr(_audit_ctx, "job_id", None), getattr(_audit_ctx, "filename", None)


# ─── Agent runners ──────────────────────────────────────────────────────────
def _run_triage(client, deployment, transcript_for_prompt):
    user = (
        f"TRANSCRIPT (numbered, speaker-labeled, code-mixed Indian languages):\n\n"
        f"{transcript_for_prompt}\n\n"
        f"Apply the triage rules in strict order and return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, SYS_TRIAGE, user, max_tokens=500)
    jid, fn = _audit_ctx_get()
    audit_log.log_llm_call(
        job_id=jid, filename=fn, agent="triage",
        system_prompt=SYS_TRIAGE,
        prompt_tokens=cost["prompt_tokens"], completion_tokens=cost["completion_tokens"],
        cost_usd_total=cost["cost_usd_total"], wall_time_s=cost["wall_time_s"],
        parsed_keys=list(result.keys()) if isinstance(result, dict) else [],
        extra={"short_circuited": not result.get("needs_full_pipeline", True)} if isinstance(result, dict) else None,
    )
    return result, cost


def _run_specialist(client, deployment, name, transcript_for_prompt):
    spec = SPECIALIST_REGISTRY[name]
    user = (
        f"TRANSCRIPT (numbered, speaker-labeled, code-mixed Indian languages — read all scripts):\n\n"
        f"{transcript_for_prompt}\n\n"
        f"Analyze per your role and return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, spec["system"], user, spec["max_tokens"])
    jid, fn = _audit_ctx_get()
    audit_log.log_llm_call(
        job_id=jid, filename=fn, agent=name,
        system_prompt=spec["system"],
        prompt_tokens=cost["prompt_tokens"], completion_tokens=cost["completion_tokens"],
        cost_usd_total=cost["cost_usd_total"], wall_time_s=cost["wall_time_s"],
        parsed_keys=list(result.keys()) if isinstance(result, dict) else [],
    )
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
    # Renumbered keys for readability in the prompt. v3 has a merged
    # identity_and_extraction specialist (was two separate ones in v2).
    body_renamed = {
        "identity_and_extraction": body.get("identity_and_extraction"),
        "fraud_risk":              body.get("fraud_risk"),
        "conversation":            body.get("conversation_behavior"),
    }
    # Compact JSON (no indent) saves significant whitespace tokens
    user = (
        f"TRANSCRIPT:\n{transcript_for_prompt}\n\n"
        f"SPECIALISTS:\n{json.dumps(body_renamed, ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"Apply chain-of-thought, disambiguation, and confidence caps. Return ONLY the required JSON."
    )
    result, cost = _call_llm(client, deployment, SYS_SYNTHESIZER, user, max_tokens=2500)
    jid, fn = _audit_ctx_get()
    audit_log.log_llm_call(
        job_id=jid, filename=fn, agent="decision_agent",
        system_prompt=SYS_SYNTHESIZER,
        prompt_tokens=cost["prompt_tokens"], completion_tokens=cost["completion_tokens"],
        cost_usd_total=cost["cost_usd_total"], wall_time_s=cost["wall_time_s"],
        parsed_keys=list(result.keys()) if isinstance(result, dict) else [],
    )
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
    jid, fn = _audit_ctx_get()
    audit_log.log_llm_call(
        job_id=jid, filename=fn, agent="reflection",
        system_prompt=SYS_REFLECTION,
        prompt_tokens=cost["prompt_tokens"], completion_tokens=cost["completion_tokens"],
        cost_usd_total=cost["cost_usd_total"], wall_time_s=cost["wall_time_s"],
        parsed_keys=list(result.keys()) if isinstance(result, dict) else [],
        extra={
            "agreement": result.get("agreement_with_decision") if isinstance(result, dict) else None,
            "confidence_delta": result.get("confidence_delta") if isinstance(result, dict) else None,
            "routing_override": result.get("routing_override") if isinstance(result, dict) else None,
        },
    )
    return result, cost


# ─── Disposition → RCU-status enforcement ───────────────────────────────────
# Canonical mapping (per Bajaj TC dispositions doc + prompts.py rubric).
# Lowercased keys for normalisation-tolerant lookup.
# Canonical disposition sets — synced verbatim with the customer's BACL
# TC Dispositions xlsx (Applicant + Monnai + Co-applicant sheets) and the
# Scope of Speech Analytics doc definitions.
_CRITICAL_DISPOSITIONS = {
    # Applicant-sheet Critical
    "third party use",
    "third party mobile no",
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
    # Monnai-sheet (Critical M / O / MO all roll up to "Critical")
    "monnai name mismatch",
    "monnai name belongs to third party",
    "mobile number belongs to monnai",
    "tenure less than 3 months",
    "tenure less than 3months",
    # Co-applicant-sheet Critical
    "person is not co-applicant",
    "third party mobile number",
    "mob no not use by coa not family",
}
_NEGATIVE_DISPOSITIONS = {
    # Applicant-sheet Negative
    "third party attending calls(family-close blood relative)",
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
    # Co-applicant-sheet Negative
    "third party mobile no family close blood relative",
    "mob no not use by coa family",
}
_POSITIVE_DISPOSITIONS = {
    "no negative information",
    # Co-applicant-sheet Positive
    "no negative information (includes-only enq)",
    "app mob no use by coa family",
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


def _enforce_disposition_rules(
    output: dict, specialist_results: dict,
) -> dict:
    """Deterministic post-hoc rules that the LLM keeps getting wrong despite
    being in the prompt. Applied AFTER the Decision Agent + Reflection. These
    are pure post-processing — they don't change the model's reasoning, just
    correct the final disposition when a hard rule from the RCU_Context spec
    fires unambiguously.

    Two rules currently:

      Rule R1 — "Rented Residing Less Than 1 Year" beats "Incomplete Information"
        If the Identity check flags flag_rented_under_1_year=true AND caller
        is Applicant AND the model picked "Incomplete Information" → upgrade
        to "Rented Residing Less Than 1 Year" (Critical). Per the BACL spec,
        this is an Applicant-only Critical disposition that the data clearly
        warrants.

      Rule R2 — 3W / commercial vehicle exception on "Driver is not co-applicant"
        Per the Scope doc, the disposition is "Negative — except the owner is
        fleet owner or vehicle is being used for business purpose." Auto-rickshaws
        and any 3W are commercial-passenger by definition, so a driver
        arrangement there is legitimate, not a fraud signal. If the model
        picked this disposition and vehicle_type is 3W/Commercial/Car, drop
        to "No Negative Information" (clean) unless other Critical signals
        fire elsewhere.
    """
    if not isinstance(output, dict):
        return output

    # Aggregate signals from whichever specialist key produced them (v2 had two
    # separate specialists; v3 merges them into identity_and_extraction)
    ident = (
        specialist_results.get("identity_and_extraction")
        or specialist_results.get("identity_verification")
        or {}
    )
    info = (
        specialist_results.get("identity_and_extraction")
        or specialist_results.get("information_extraction")
        or {}
    )
    addr_check = ident.get("address_check") if isinstance(ident, dict) else None
    ext = info.get("extracted_info") if isinstance(info, dict) else None
    caller_type = output.get("caller_type") or (info.get("caller_type") if isinstance(info, dict) else None)

    out = dict(output)
    fired_rules: list[str] = []

    # Rule R1
    rented_flag = (addr_check or {}).get("flag_rented_under_1_year") if addr_check else False
    if (
        rented_flag is True
        and caller_type == "Applicant"
        and out.get("disposition") == "Incomplete Information"
    ):
        out["disposition"] = "Rented Residing Less Than 1 Year"
        out["disposition_rcu_status"] = "Critical"
        out["verdict"] = "Critical"
        fired_rules.append("R1:rented_under_1y_beats_incomplete")
        # Tighten reasoning chain so the override is auditable
        chain = list(out.get("reasoning_chain") or [])
        chain.append(
            "Post-hoc rule R1: address_check.flag_rented_under_1_year=true on "
            "Applicant call — Critical disposition 'Rented Residing Less Than "
            "1 Year' overrides 'Incomplete Information' per RCU_Context spec."
        )
        out["reasoning_chain"] = chain

    # Rule R2
    vehicle_type = (ext or {}).get("vehicle_type") if ext else None
    if (
        out.get("disposition") == "Driver is not co-applicant"
        and vehicle_type in ("3W", "Three-wheeler", "three-wheeler", "Commercial", "commercial", "Car", "car")
    ):
        # Only downgrade if no Critical signal elsewhere — preserve the LLM's
        # Negative tier instead of fast-jumping to Positive without checks
        fr = specialist_results.get("fraud_risk") or {}
        sev = (fr.get("highest_severity_observed") if isinstance(fr, dict) else None) or "none"
        if sev not in ("critical", "high"):
            out["disposition"] = "No Negative Information"
            out["disposition_rcu_status"] = "Positive"
            out["verdict"] = "Positive"
            fired_rules.append("R2:3W_excludes_driver_not_coapp")
            chain = list(out.get("reasoning_chain") or [])
            chain.append(
                f"Post-hoc rule R2: vehicle_type={vehicle_type} is commercial-"
                "passenger by default (e.g. auto-rickshaw). Driver arrangement "
                "is legitimate fleet operation, not a fraud signal — disposition "
                "downgraded to 'No Negative Information' per RCU_Context spec."
            )
            out["reasoning_chain"] = chain

    if fired_rules:
        out["_post_hoc_rules_fired"] = fired_rules
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

    final_output = _enforce_disposition_consistency(
        _enforce_disposition_rules(
            _apply_reflection(synth_out, reflection_out),
            spec_results,
        )
    )
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
    job_id: Optional[str] = None,
):
    """One call → STT (Soniox stt-async-v4 by default) → Multi-agent verification.
    STT provider is selected via the STT_PROVIDER env var. Returns unified record."""
    t_call = time.time()
    filename = os.path.basename(audio_path)
    # Set thread-local audit context so every LLM / STT call inside this
    # pipeline run logs the correct job_id + filename without manual threading.
    _set_audit_ctx(job_id, filename)
    audit_log.log("pipeline.start", job_id=job_id, filename=filename, audio_path=audio_path,
                  keyterms=keyterms or [], stt_provider=_stt_provider())

    # Stage 1: STT (routed by STT_PROVIDER env var)
    stt_data, stt_cost = transcribe_stt(audio_path, eleven_client, keyterms=keyterms)
    utterances = group_words_into_utterances(stt_data.get("words") or [])
    if not utterances:
        audit_log.log("pipeline.error", job_id=job_id, filename=filename,
                      reason="No utterances detected after STT (silent/empty audio?)")
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

    # Audit log: final decision + per-pipeline summary
    reflection_out = (verification.get("reflection") or {}).get("output") or {}
    audit_log.log_decision(
        job_id=job_id, filename=filename,
        verdict=final_output.get("verdict"),
        disposition=final_output.get("disposition"),
        disposition_rcu_status=final_output.get("disposition_rcu_status"),
        caller_type=final_output.get("caller_type"),
        confidence=final_output.get("verdict_confidence_1_10"),
        routing=final_output.get("decision_routing"),
        risk_tags=final_output.get("risk_tags") or [],
        reflection_applied=bool((verification.get("reflection") or {}).get("applied")),
        confidence_delta=reflection_out.get("confidence_delta") if isinstance(reflection_out, dict) else None,
        routing_override=reflection_out.get("routing_override") if isinstance(reflection_out, dict) else None,
        post_hoc_rules_fired=final_output.get("_post_hoc_rules_fired") or [],
        extra={
            "triage_short_circuit": bool(final_output.get("_triage_short_circuit", False)),
            "audio_duration_s": stt_cost["audio_seconds"],
            "total_cost_usd": round(total_cost, 8),
            "total_wall_time_s": round(time.time() - t_call, 2),
        },
    )

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
            "vendor": (
                "Soniox stt-async-v4"
                if stt_cost.get("provider") == "soniox_stt_async_v4"
                else "ElevenLabs Scribe v2"
            ),
            "model_id": (
                "stt-async-v4"
                if stt_cost.get("provider") == "soniox_stt_async_v4"
                else "scribe_v2"
            ),
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
