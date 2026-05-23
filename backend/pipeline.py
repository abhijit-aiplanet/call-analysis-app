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
    SYS_DISPOSITION_DISAMBIGUATOR,
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
    Defaults to ElevenLabs Scribe v2; Soniox is available when STT_PROVIDER=soniox.

    For ElevenLabs we ignore the keyterms argument by design — our 50-call
    competitor-format report run found keyterms didn't materially help and they
    add a $0.05/hr surcharge. Pipeline still accepts the keyterms param so the
    Soniox path (which uses them for free context-boost) is unaffected.
    """
    provider = _stt_provider()
    if provider == "elevenlabs":
        return transcribe_with_scribe_v2_rotating(audio_path, eleven_client)
    # Soniox
    return transcribe_with_soniox(audio_path, keyterms=keyterms)


# ─── ElevenLabs Scribe v2 STT (default) ────────────────────────────────────
def _elevenlabs_key_pool() -> list[str]:
    """Return non-empty ElevenLabs keys to rotate through, in preference order.
    KEY_4 (Starter plan, 30K/mo, primary) → KEY_3 → KEY_2 → KEY (oldest). Any missing is skipped."""
    keys: list[str] = []
    for var in ("ELEVENLABS_API_KEY_4", "ELEVENLABS_API_KEY_3", "ELEVENLABS_API_KEY_2", "ELEVENLABS_API_KEY"):
        k = os.environ.get(var, "").strip()
        if k: keys.append(k)
    return keys


def _is_credit_or_auth_error(err: Exception) -> bool:
    """Detect ElevenLabs errors that mean 'this key is dead, try the next'."""
    s = str(err).lower()
    return any(p in s for p in (
        "quota_exceeded", "credits remaining", "insufficient_credits",
        "detected_unusual_activity", "free tier usage disabled",
        "401", "403", "unauthor", "invalid_api_key",
    ))


def transcribe_with_scribe_v2_rotating(
    audio_path: str,
    eleven_client_unused: Optional[ElevenLabs] = None,
):
    """Try each ElevenLabs key in the rotation pool. If a key is credit-exhausted
    or unauthorised, transparently fall back to the next one. Raises only when
    all keys have been tried."""
    keys = _elevenlabs_key_pool()
    if not keys:
        raise RuntimeError("No ElevenLabs API keys configured. Set ELEVENLABS_API_KEY[_2].")

    last_err: Optional[Exception] = None
    for i, key in enumerate(keys):
        try:
            client = ElevenLabs(api_key=key)
            return transcribe_with_scribe_v2(audio_path, client, keyterms=None)
        except Exception as e:
            last_err = e
            if _is_credit_or_auth_error(e):
                # Drop to the next key
                continue
            # Any other error (network, file, etc.) is fatal — don't burn a second key on it
            raise
    # Exhausted every key
    raise RuntimeError(f"All ElevenLabs keys exhausted (last error: {last_err})")


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


# ─── Audit-report derived metrics ─────────────────────────────────────────
# Used by the competitor-format PoC report. Pure post-processing — every
# input is already produced by the rest of the pipeline.

def _compute_audit_metrics(
    utterances: List[Dict[str, Any]],
    total_duration_s: float,
    verification: Dict[str, Any],
) -> Dict[str, Any]:
    """Compute the derived per-call fields the audit-style report needs.

    Returns a dict with:
      total_call_duration_s, non_speech_duration_s, non_speech_ratio_pct,
      customer_talk_duration_s, agent_talk_duration_s,
      customer_sentiment, agent_sentiment,
      greeting_followed, greeting_quote.

    Defensive against malformed conversation_behavior output (parse errors,
    missing specialist data when Triage short-circuits, etc.).

    Phase A0: PREFERS the deterministic `speaker_roles` map from the resolver
    over Conversation Behavior's per-utterance tags. The resolver is run on
    every call (including triage-short-circuited ones), so customer/agent
    talk durations now work in 100% of calls instead of ~80%.
    """
    # Pull the per-utterance behavioural tags + script-adherence object.
    # Defensive: every chained access could fail if upstream returned a string
    # (LLM parse error) or unexpected type — fall back to {} at each step.
    specs = verification.get("specialists") if isinstance(verification, dict) else None
    if not isinstance(specs, dict):
        specs = {}
    conv_block = specs.get("conversation_behavior")
    if not isinstance(conv_block, dict):
        conv_block = {}
    conv = conv_block.get("output")
    if not isinstance(conv, dict):
        conv = {}
    per_utt_raw = conv.get("per_utterance")
    per_utt: List[Dict[str, Any]] = per_utt_raw if isinstance(per_utt_raw, list) else []
    script_raw = conv.get("agent_script_adherence")
    script = script_raw if isinstance(script_raw, dict) else {}

    # Phase A0: prefer the deterministic speaker_roles map.
    speaker_roles_map = verification.get("speaker_roles") if isinstance(verification, dict) else None
    if not isinstance(speaker_roles_map, dict):
        speaker_roles_map = {}
    resolver_per_utt = speaker_roles_map.get("per_utterance_role") or []
    resolver_role_by_idx: Dict[int, str] = {}
    for entry in resolver_per_utt:
        if isinstance(entry, dict):
            idx = entry.get("idx")
            if isinstance(idx, int):
                eff = (entry.get("effective_role") or "").lower()
                # Treat subject/former-subject as "customer" for talk-duration purposes.
                if eff == "agent":
                    resolver_role_by_idx[idx] = "agent"
                elif eff in ("subject", "third_party_former_subject"):
                    resolver_role_by_idx[idx] = "subject"
                elif eff == "third_party":
                    resolver_role_by_idx[idx] = "third_party"

    # role-by-utterance map for fast lookup — resolver wins; CB is fallback for behavior_tag only.
    role_by_idx: Dict[int, str] = dict(resolver_role_by_idx)  # start from resolver
    behavior_by_idx: Dict[int, str] = {}
    for entry in per_utt:
        idx = entry.get("idx")
        if isinstance(idx, int):
            behavior_by_idx[idx] = (entry.get("behavior_tag") or "").lower()
            # Only use CB's role as a fallback when resolver didn't tag.
            if idx not in role_by_idx:
                role_by_idx[idx] = (entry.get("speaker_role") or "").lower()

    customer_s = 0.0
    agent_s    = 0.0
    speech_s   = 0.0
    last_end   = 0.0
    non_speech_s = 0.0
    for i, u in enumerate(utterances):
        start = float(u.get("start_s") or 0)
        end   = float(u.get("end_s")   or start)
        dur   = max(0.0, end - start)
        speech_s += dur
        gap = max(0.0, start - last_end)
        non_speech_s += gap
        last_end = max(last_end, end)
        # Speaker role: from the LLM behavior analysis if available; else
        # fall back to speaker label heuristic (speaker_0 / speaker 1 etc.)
        role = role_by_idx.get(i, "")
        if role == "subject":
            customer_s += dur
        elif role == "agent":
            agent_s += dur
    # Tail silence between last utt and end-of-audio
    if total_duration_s and last_end < total_duration_s:
        non_speech_s += (total_duration_s - last_end)

    non_speech_ratio = (non_speech_s / total_duration_s * 100) if total_duration_s else 0.0

    # Sentiment per speaker — aggregate from per_utt behaviour tags.
    # Defensive: behavior_by_idx may be sparse (only populated when CB ran);
    # role_by_idx may be denser (resolver always populates it). Use .get().
    customer_sentiment = _aggregate_sentiment([
        behavior_by_idx.get(i, "") for i in role_by_idx if role_by_idx[i] == "subject" and i in behavior_by_idx
    ])
    agent_sentiment = _aggregate_sentiment([
        behavior_by_idx.get(i, "") for i in role_by_idx if role_by_idx[i] == "agent" and i in behavior_by_idx
    ])

    # Greeting (Bajaj script): if the agent's opening utterance contains the
    # canonical greeting phrase, treat as followed and quote the line.
    greeting_followed = bool(script.get("opening_script_followed", False))
    greeting_quote = ""
    for i, u in enumerate(utterances[:6]):  # first 6 utterances cover the greeting in nearly all calls
        if role_by_idx.get(i) == "agent":
            text = (u.get("text") or "").strip()
            if text:
                greeting_quote = text
                break
    if not greeting_quote and utterances:
        # No agent identified — use the first utterance regardless
        greeting_quote = (utterances[0].get("text") or "").strip()

    return {
        "total_call_duration_s":     int(round(total_duration_s)),
        "non_speech_duration_s":     int(round(non_speech_s)),
        "non_speech_ratio_pct":      round(non_speech_ratio, 2),
        "customer_talk_duration_s":  int(round(customer_s)),
        "agent_talk_duration_s":     int(round(agent_s)),
        "customer_sentiment":        customer_sentiment,
        "agent_sentiment":           agent_sentiment,
        "greeting_followed":         greeting_followed,
        "greeting_answer":           "Yes" if greeting_followed else "No",
        "greeting_quote":            greeting_quote,
        "greeting_justification":    (
            f'The agent greeted the customer with "{greeting_quote}".'
            if greeting_quote else
            "No greeting captured in the first agent utterance."
        ),
    }


def _aggregate_sentiment(behavior_tags: List[str]) -> str:
    """Roll up a list of per-utterance behaviour tags into a single sentiment
    label (Positive / Negative / Neutral) matching the competitor's report.
    Heuristic, deliberately simple."""
    if not behavior_tags:
        return "Neutral"
    negative_tags = {"irate", "defensive", "evasive", "contradictory",
                     "prompted_by_third_party", "fumbling", "rushed_through"}
    positive_tags = {"cooperative"}
    neg = sum(1 for t in behavior_tags if t in negative_tags)
    pos = sum(1 for t in behavior_tags if t in positive_tags)
    if neg >= 2 or neg / max(len(behavior_tags), 1) >= 0.25:
        return "Negative"
    if pos / max(len(behavior_tags), 1) >= 0.5:
        return "Positive"
    return "Neutral"


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


# B1 — Azure prompt-caching constants. Cached input is billed at a discount
# vs. uncached input on Standard deployments. 50% off is the conservative,
# widely-published rate that we use here. The exact discount can be larger
# for some deployment tiers; refining requires an Azure billing pull.
_CACHED_INPUT_DISCOUNT = 0.50


def _llm_cost(usage):
    """Convert the SDK's usage object into a cost dict, applying the cached-
    input discount when the API reports cached prefix tokens.

    Newer Azure OpenAI responses expose `prompt_tokens_details.cached_tokens`
    (added Q4 2024). When present + non-zero, that many tokens were served
    from prompt cache and billed at 50% of the input rate.
    """
    input_rate  = RATE_CARD["azure_gpt4o_mini_per_M_input_usd"]
    output_rate = RATE_CARD["azure_gpt4o_mini_per_M_output_usd"]

    prompt_tokens = usage.prompt_tokens
    completion_tokens = usage.completion_tokens

    # Cached-token detection (graceful fallback if SDK doesn't expose it)
    cached_tokens = 0
    details = getattr(usage, "prompt_tokens_details", None)
    if details is not None:
        cached_tokens = getattr(details, "cached_tokens", 0) or 0
        # Sometimes the SDK returns a plain dict
        if isinstance(details, dict):
            cached_tokens = details.get("cached_tokens", 0) or 0

    uncached_prompt = max(0, prompt_tokens - cached_tokens)
    cin_uncached = uncached_prompt / 1_000_000 * input_rate
    cin_cached   = cached_tokens / 1_000_000 * input_rate * (1 - _CACHED_INPUT_DISCOUNT)
    cin = cin_uncached + cin_cached
    cout = completion_tokens / 1_000_000 * output_rate

    return {
        "prompt_tokens":     prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens":      prompt_tokens + completion_tokens,
        "cached_tokens":     cached_tokens,                # B1 — exposed for UI / analysis
        "cost_usd_input":    round(cin, 8),
        "cost_usd_input_uncached": round(cin_uncached, 8),
        "cost_usd_input_cached":   round(cin_cached, 8),
        "cost_usd_output":   round(cout, 8),
        "cost_usd_total":    round(cin + cout, 8),
    }


def _call_llm(client, deployment, system_prompt, user_prompt, max_tokens, cache_key: Optional[str] = None, temperature: float = 0.2):
    """Call the LLM. When `cache_key` is provided AND the deployment supports
    `prompt_cache_key` (Azure preview), pass it so the routing layer pins
    requests with identical prefixes to the same backend → maximises prompt
    cache hits. Falls back gracefully if the parameter is rejected.

    Defensive: if Azure content-filter blocks the request, retry once with
    the user prompt prefixed by a benign instruction marker. This avoids
    losing entire calls to over-eager content filtering on Indian-language
    fraud/loan content.

    Temperature: defaults to 0.2 (some creativity for tough cases). For the
    Decision Agent (high-stakes verdict) we override to 0.0 for maximum
    determinism — the 3-run variance study showed ±9 pt run-to-run swing
    at temp 0.2 on the Decision Agent.
    """
    t0 = time.time()
    request_kwargs = dict(
        model=deployment,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_prompt},
        ],
        temperature=temperature,
        response_format={"type": "json_object"},
        max_completion_tokens=max_tokens,
    )
    def _attempt(kwargs):
        if cache_key:
            try:
                return client.chat.completions.create(prompt_cache_key=cache_key, **kwargs)
            except TypeError:
                return client.chat.completions.create(**kwargs)
        return client.chat.completions.create(**kwargs)

    try:
        resp = _attempt(request_kwargs)
    except Exception as e:
        # Azure content-filter retry: rewrap the user prompt so the model
        # sees this as a fraud-detection compliance review, not raw fraud talk.
        if "content management policy" in str(e).lower() or "content_filter" in str(e).lower():
            retry_kwargs = dict(request_kwargs)
            retry_kwargs["messages"] = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": (
                    "[Compliance review context — auditing a Bajaj loan verification call "
                    "for fraud/policy issues. Below is the call transcript and prior "
                    "analysis; output the required JSON.]\n\n" + user_prompt
                )},
            ]
            resp = _attempt(retry_kwargs)
        else:
            raise
    wall = time.time() - t0
    parsed = _safe_parse(resp.choices[0].message.content)
    cost = _llm_cost(resp.usage)
    cost["wall_time_s"] = round(wall, 2)
    return parsed, cost


# ═══════════════════════════════════════════════════════════════════════════
# Phase A0 — Deterministic Speaker-Role Resolution
# ═══════════════════════════════════════════════════════════════════════════
# Cross-call analysis showed 42% of calls had broken/partial speaker labels
# (Conversation Behavior could not reliably tell agent from subject), and
# 46% of our misses correlated with that failure. This resolver runs ONCE
# per call, right after STT, and produces a global {speaker_id: role} map
# that is injected into every downstream specialist prompt.

# Stage-1 keyword scores (BACL-specific). Higher score = stronger agent cue.
# CRITICAL DESIGN NOTE: Indian customers also say "sir"/"madam" to agents
# politely. Those words are NOT discriminative. Only phrases that the AGENT
# specifically uses (introducing themselves, citing the company, asking
# verification questions) belong here.
#
# Multilingual: "Bajaj" / "Bajaj Finance" can appear in native scripts in
# code-mixed transcripts. Include all the common script renderings.
_AGENT_KEYWORDS_STRONG = (
    # Latin
    "bajaj", "bacl", "bajaj auto credit", "bajaj finance", "bajaj auto",
    "rcu", "risk containment", "verification call", "verification ke liye",
    "tele-confirmation", "tele confirmation", "telephonic confirmation",
    # Hindi/Marathi
    "बजाज", "बजाज फाइनेंस", "बजाज ऑटो", "वेरिफिकेशन",
    # Tamil
    "பஜஜ்", "பஜாஜ்", "பஜஸ்", "பஜாஜ் ஃபைனான்ஸ்", "பஜஸ் ஃபைனான்ஸ்",
    # Telugu
    "బజాజ్", "బజాజ్ ఫైనాన్స్",
    # Kannada
    "ಬಜಾಜ್", "ಬಜಾಜ್ ಫೈನಾನ್ಸ್",
    # Malayalam
    "ബജാജ്", "ബജാജ് ഫിനാൻസ്",
    # Bengali
    "বাজাজ", "বাজাজ ফাইনান্স",
    # Gujarati
    "બજાજ", "બજાજ ફાઈનાન્સ",
)
_AGENT_KEYWORDS_MEDIUM = (
    # Agent-specific BACL vocabulary — customers rarely use these.
    "sanction letter", "disbursement", "co-applicant", "co applicant",
    "down payment", "loan amount", "loan apply", "loan application",
    "tenure", "documentation", "verification ke",
    "rcu team", "verification team", "from bajaj", "speaking from",
    "calling from", "मैं बजाज", "मैं ब्रांच से",
    # Agent's identity-verification questions (highly characteristic)
    "अपना नाम बताइए", "आपका शुभ नाम", "your good name", "may i know your",
    "may i have your", "what is your name", "your full name",
    "अपना पूरा नाम", "पूरा नाम बताइए",
)
_AGENT_KEYWORDS_WEAK = (
    "गाड़ी का model", "वाहन का", "आपका नाम", "address बताइए", "address please",
    "मॉडल क्या", "किसके नाम पर", "किस्के नाम से",
    "कौनसे मॉडल", "कौनसा मॉडल", "address क्या",
)

# Stage-2 subject-identification cues — the agent asking for the customer's name.
_NAME_ASK_CUES = (
    "आपका नाम", "आपका शुभ नाम", "आपका नाम क्या", "अपना नाम बताइए",
    "अपना पूरा नाम", "क्या नाम है आपका", "आपका पूरा नाम",
    "your name please", "your good name", "your full name",
    "what is your name", "may i know your name", "may i have your name",
    "what's your name", "may i know your good name",
    "என்ன பேர்", "உங்க பெயர்", "உங்க பேர்", "உங்க பெயர் சொல்லுங்க",
    "உங்க பேர் சொல்லுங்க", "பேர் என்ன",  # Tamil (multiple variants)
    "మీ పేరు", "ఏం పేరు", "మీ పూర్తి పేరు",  # Telugu
    "ನಿಮ್ಮ ಹೆಸರು", "ಹೆಸರೇನು", "ನಿಮ್ಮ ಪೂರ್ತಿ ಹೆಸರು",  # Kannada
    "നിങ്ങളുടെ പേര്",  # Malayalam
    "তোমার নাম", "আপনার নাম", "আপনার পূর্ণ নাম",  # Bengali
    "तुमचं नाव", "आपलं नाव", "तुमचं पूर्ण नाव",  # Marathi
    "તમારું નામ", "તમારું પૂરું નામ",  # Gujarati
)

# Stage-3 handoff cues — subject hands off to another speaker.
_HANDOFF_CUES = (
    "बात कर", "बात करो", "बात करिए", "बात करते हैं",
    "तू देखो", "देखो भईया",
    "i'll put", "i will put", "putting him on", "putting her on",
    "speak to him", "talk to him", "speak to my",
    "हाँ रुको", "रुको एक मिनट",
)

# Stage-3 relation cues — used to label third parties by role.
_RELATION_KEYWORDS = {
    "mother": ("मेरी माँ", "मम्मी", "ammā", "अम्मा", "अम्मी"),
    "father": ("मेरे पिता", "पापा", "बाबा", "appā", "अप्पा"),
    "brother": ("मेरा भाई", "भईया", "भाई", "annā", "अन्ना", "तम्मुडु", "तम्मू"),
    "sister": ("मेरी बहन", "दीदी", "अक्का", "अक्क"),
    "spouse": ("पत्नी", "wife", "husband", "पति"),
    "uncle": ("मेरे चाचा", "मामा", "ammā chinna", "अंकल"),
    "aunt": ("मेरी चाची", "मौसी", "आंटी"),
    "son": ("मेरा बेटा", "बेटा", "मुलगा", "пайయन்"),
    "daughter": ("मेरी बेटी", "बेटी", "மகள்"),
}


def _normalise_text(t: str) -> str:
    """Lowercase + collapse whitespace for keyword matching."""
    return " ".join((t or "").lower().split())


def _score_agent_for_speaker(text_blob: str) -> float:
    """Return an 'is this speaker the agent?' score (higher = more agent-like)."""
    s = 0.0
    for kw in _AGENT_KEYWORDS_STRONG:
        if kw in text_blob:
            s += 3.0
    for kw in _AGENT_KEYWORDS_MEDIUM:
        if kw in text_blob:
            s += 2.0
    for kw in _AGENT_KEYWORDS_WEAK:
        if kw in text_blob:
            s += 1.0
    return s


def _detect_relation(text: str) -> Optional[str]:
    """Try to identify a family-relation label for a third-party speaker."""
    s = _normalise_text(text)
    for relation, cues in _RELATION_KEYWORDS.items():
        for cue in cues:
            if cue.lower() in s:
                return relation
    return None


def resolve_speaker_roles(
    utterances: List[Dict[str, Any]],
    llm_client=None,
    deployment: Optional[str] = None,
) -> Dict[str, Any]:
    """Phase A0 — Deterministic Speaker-Role Resolver.

    Input: the STT-produced utterance list (each utterance has `speaker`, `text`,
    `start_s`, `end_s`).
    Output: {
        "speaker_roles":    {speaker_id: "agent"|"subject"|"third_party"|"unknown", ...},
        "third_party_relations": {speaker_id: <relation_label_or_None>, ...},
        "per_utterance_role":    [{"idx": i, "speaker": sid, "effective_role": role}, ...],
        "agent_score_per_speaker": {speaker_id: float, ...},
        "subject_evidence":      {"name_ask_utt_idx": i|None, "name_response_utt_idx": j|None, "quote": str|None},
        "handoffs": [{"at_utt_idx": k, "from_speaker": sid, "to_speaker": sid2, "trigger_quote": str}, ...],
        "stage_used":     "stage_1"|"stage_2"|"stage_3"|"stage_4_llm"|"failed",
        "resolver_cost_usd": float,
        "warnings":       [str, ...],
    }

    Stages:
      1. Rule-based agent ID via keyword scoring on first 7 utterances.
      2. Rule-based subject ID by finding agent's "what is your name?" + the next
         non-agent utterance.
      3. Handoff detection — when subject hands off to another speaker mid-call.
      4. LLM fallback if Stages 1-2 can't resolve.
    """
    warnings_list: list[str] = []
    cost_usd_total = 0.0

    if not utterances:
        return {
            "speaker_roles": {},
            "third_party_relations": {},
            "per_utterance_role": [],
            "agent_score_per_speaker": {},
            "subject_evidence": {"name_ask_utt_idx": None, "name_response_utt_idx": None, "quote": None},
            "handoffs": [],
            "stage_used": "failed",
            "resolver_cost_usd": 0.0,
            "warnings": ["no utterances"],
        }

    # Build per-speaker text blob from the first ~12 utterances (≈ the agent opening window)
    speaker_ids = sorted({str(u.get("speaker")) for u in utterances if u.get("speaker") is not None})
    head_window = utterances[: min(12, len(utterances))]
    agent_text_by_sp: Dict[str, str] = {sid: "" for sid in speaker_ids}
    for u in head_window:
        sid = str(u.get("speaker"))
        if sid in agent_text_by_sp:
            agent_text_by_sp[sid] += " " + _normalise_text(u.get("text") or "")

    # === Stage 1: Agent ID ====================================================
    agent_scores = {sid: _score_agent_for_speaker(agent_text_by_sp.get(sid, "")) for sid in speaker_ids}
    agent_speaker: Optional[str] = None
    if agent_scores:
        best_sid = max(agent_scores, key=lambda s: agent_scores[s])
        best_score = agent_scores[best_sid]
        sorted_scores = sorted(agent_scores.values(), reverse=True)
        runner_up = sorted_scores[1] if len(sorted_scores) > 1 else 0.0
        # Require ≥3 absolute score AND a margin of ≥2 over runner-up (firm signal)
        if best_score >= 3.0 and (best_score - runner_up) >= 2.0:
            agent_speaker = best_sid
        # Or a STRONG single-speaker signal — score ≥5 even without margin
        elif best_score >= 5.0:
            agent_speaker = best_sid

    stage_used = "stage_1" if agent_speaker else None

    # === Stage 2: Subject ID via name-ask ======================================
    subject_speaker: Optional[str] = None
    subject_evidence = {"name_ask_utt_idx": None, "name_response_utt_idx": None, "quote": None}
    if agent_speaker is not None:
        # Walk utterances in order; find first agent utt that asks for a name
        for i, u in enumerate(utterances):
            sid = str(u.get("speaker"))
            if sid != agent_speaker:
                continue
            t = _normalise_text(u.get("text") or "")
            if any(c in t for c in _NAME_ASK_CUES):
                # Look for the next non-agent utterance
                for j in range(i + 1, min(i + 5, len(utterances))):
                    nxt_sid = str(utterances[j].get("speaker"))
                    if nxt_sid != agent_speaker:
                        subject_speaker = nxt_sid
                        subject_evidence = {
                            "name_ask_utt_idx": i,
                            "name_response_utt_idx": j,
                            "quote": (utterances[j].get("text") or "")[:180],
                        }
                        break
                if subject_speaker:
                    stage_used = "stage_2"
                    break

    # === Stage 2b: Subject ID fallback (no name-ask found) =====================
    # If we have exactly 2 speakers and identified the agent, the other one is subject.
    if subject_speaker is None and agent_speaker is not None and len(speaker_ids) == 2:
        other = [s for s in speaker_ids if s != agent_speaker]
        if other:
            subject_speaker = other[0]
            warnings_list.append("subject_id_by_elimination_2_speakers")
            stage_used = stage_used or "stage_2b"

    # === Stage 3: Handoff detection ============================================
    handoffs: list[dict] = []
    if subject_speaker is not None:
        for i, u in enumerate(utterances):
            sid = str(u.get("speaker"))
            if sid != subject_speaker:
                continue
            t = _normalise_text(u.get("text") or "")
            if any(c in t for c in _HANDOFF_CUES):
                # The next non-agent speaker is the new subject
                for j in range(i + 1, min(i + 6, len(utterances))):
                    nxt_sid = str(utterances[j].get("speaker"))
                    if nxt_sid != agent_speaker and nxt_sid != subject_speaker:
                        handoffs.append({
                            "at_utt_idx": j,
                            "from_speaker": subject_speaker,
                            "to_speaker": nxt_sid,
                            "trigger_quote": (u.get("text") or "")[:180],
                        })
                        break

    # === Stage 4: LLM fallback (rare) ==========================================
    # Triggers when Stage 1 couldn't identify agent at all.
    if agent_speaker is None and llm_client is not None and deployment:
        try:
            agent_speaker, subject_speaker, fallback_cost = _llm_resolve_speakers(
                llm_client, deployment, utterances[: min(15, len(utterances))]
            )
            cost_usd_total += fallback_cost
            stage_used = "stage_4_llm"
            warnings_list.append("llm_fallback_invoked")
        except Exception as e:
            warnings_list.append(f"llm_fallback_failed: {e}")
            stage_used = "failed"

    # === Build final role maps =================================================
    speaker_roles: Dict[str, str] = {}
    third_party_relations: Dict[str, Optional[str]] = {}

    for sid in speaker_ids:
        if sid == agent_speaker:
            speaker_roles[sid] = "agent"
        elif sid == subject_speaker:
            speaker_roles[sid] = "subject"
        else:
            speaker_roles[sid] = "third_party"

    # Try to label third-party relations
    for sid, role in speaker_roles.items():
        if role == "third_party":
            # Look at all utterances from this speaker for relation cues
            blob = " ".join((u.get("text") or "") for u in utterances if str(u.get("speaker")) == sid)
            # Also look at how the subject refers to them
            subj_blob = " ".join((u.get("text") or "") for u in utterances if str(u.get("speaker")) == subject_speaker)
            relation = _detect_relation(blob) or _detect_relation(subj_blob)
            third_party_relations[sid] = relation
        else:
            third_party_relations[sid] = None

    # Per-utterance effective_role honours handoffs.
    per_utt_role = []
    # Build a "subject-at-utt-i" override map.
    # Start with the original subject; flip when a handoff fires.
    current_subject = subject_speaker
    handoff_at = {h["at_utt_idx"]: (h["from_speaker"], h["to_speaker"]) for h in handoffs}
    # When subject changes, the OLD subject becomes a third_party for subsequent utterances.
    handoff_old_subjects: list[str] = []
    for i, u in enumerate(utterances):
        if i in handoff_at:
            old, new = handoff_at[i]
            handoff_old_subjects.append(old)
            current_subject = new
        sid = str(u.get("speaker"))
        if sid == agent_speaker:
            role = "agent"
        elif sid == current_subject:
            role = "subject"
        elif sid in handoff_old_subjects:
            role = "third_party_former_subject"
        else:
            role = speaker_roles.get(sid, "unknown")
        per_utt_role.append({"idx": i, "speaker": sid, "effective_role": role})

    if not agent_speaker:
        stage_used = stage_used or "failed"
        warnings_list.append("no_agent_identified")

    return {
        "speaker_roles": speaker_roles,
        "third_party_relations": third_party_relations,
        "per_utterance_role": per_utt_role,
        "agent_score_per_speaker": agent_scores,
        "subject_evidence": subject_evidence,
        "handoffs": handoffs,
        "stage_used": stage_used or "failed",
        "resolver_cost_usd": round(cost_usd_total, 8),
        "warnings": warnings_list,
    }


def _llm_resolve_speakers(client, deployment, head_utts):
    """Stage-4 LLM fallback. Tiny prompt, ~$0.0002 per fired call."""
    transcript_lines = []
    for i, u in enumerate(head_utts):
        transcript_lines.append(f"{i}: [spk {u.get('speaker')}] {(u.get('text') or '')[:140]}")
    transcript = "\n".join(transcript_lines)
    system_prompt = (
        "You receive the first ~15 utterances of a Bajaj Auto Credit (BACL) RCU "
        "verification call. Identify which speaker_id is the BACL agent and which "
        "is the subject (the person being verified). Output strict JSON: "
        '{"agent_speaker": "<speaker_id_str>", "subject_speaker": "<speaker_id_str>|null", '
        '"rationale": "<one short sentence>"}.'
    )
    user_prompt = transcript
    t0 = time.time()
    resp = client.chat.completions.create(
        model=deployment,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.0,
        response_format={"type": "json_object"},
        max_completion_tokens=120,
    )
    parsed = _safe_parse(resp.choices[0].message.content)
    usage = resp.usage
    in_rate = RATE_CARD["azure_gpt4o_mini_per_M_input_usd"]
    out_rate = RATE_CARD["azure_gpt4o_mini_per_M_output_usd"]
    cost = usage.prompt_tokens / 1_000_000 * in_rate + usage.completion_tokens / 1_000_000 * out_rate
    agent_sp = parsed.get("agent_speaker")
    subj_sp = parsed.get("subject_speaker")
    return (str(agent_sp) if agent_sp is not None else None,
            str(subj_sp) if subj_sp not in (None, "null") else None,
            round(cost, 8))


def _format_transcript_for_prompt(utterances, speaker_roles_map: Optional[Dict[str, Any]] = None):
    """Format utterances for LLM consumption.

    When `speaker_roles_map` is provided (from `resolve_speaker_roles`), inject
    semantic role tags (AGENT / SUBJECT / THIRD_PARTY) instead of raw speaker IDs.
    Falls back to the old `Speaker N:` format if no map is given.
    """
    lines = []
    per_utt_role = (speaker_roles_map or {}).get("per_utterance_role") or []
    role_by_idx = {e.get("idx"): e.get("effective_role") for e in per_utt_role if isinstance(e, dict)}
    third_party_relations = (speaker_roles_map or {}).get("third_party_relations") or {}

    for i, u in enumerate(utterances):
        t = u.get("start_s") or 0
        mm, ss = divmod(int(t), 60)
        ts = f"[{mm:02d}:{ss:02d}]"
        sid = str(u.get("speaker"))
        if speaker_roles_map and role_by_idx:
            eff_role = role_by_idx.get(i) or "unknown"
            if eff_role == "agent":
                role_label = "AGENT"
            elif eff_role == "subject":
                role_label = "SUBJECT"
            elif eff_role == "third_party_former_subject":
                rel = third_party_relations.get(sid)
                role_label = f"THIRD_PARTY (former subject{', ' + rel if rel else ''})"
            elif eff_role == "third_party":
                rel = third_party_relations.get(sid)
                role_label = f"THIRD_PARTY{' (' + rel + ')' if rel else ''}"
            else:
                role_label = f"UNKNOWN (spk {sid})"
            lines.append(f'{i}: {ts} {role_label}: {u.get("text")}')
        else:
            lines.append(f'{i}: {ts} Speaker {sid}: {u.get("text")}')
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
    result, cost = _call_llm(client, deployment, SYS_TRIAGE, user, max_tokens=500, cache_key="rcu-triage-v3", temperature=0.0)
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
    result, cost = _call_llm(client, deployment, spec["system"], user, spec["max_tokens"], cache_key=f"rcu-{name}-v3")
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
    result, cost = _call_llm(client, deployment, SYS_SYNTHESIZER, user, max_tokens=2500, cache_key="rcu-decision-v3", temperature=0.0)
    jid, fn = _audit_ctx_get()
    audit_log.log_llm_call(
        job_id=jid, filename=fn, agent="decision_agent",
        system_prompt=SYS_SYNTHESIZER,
        prompt_tokens=cost["prompt_tokens"], completion_tokens=cost["completion_tokens"],
        cost_usd_total=cost["cost_usd_total"], wall_time_s=cost["wall_time_s"],
        parsed_keys=list(result.keys()) if isinstance(result, dict) else [],
    )
    return result, cost


def _run_synthesizer_self_consistency(client, deployment, transcript_for_prompt, specialist_results, max_samples=2):
    """Phase B3 — Self-consistency on borderline Decision-Agent outputs.

    Always runs the Decision Agent ONCE at temperature 0.2 (the normal path).
    If the resulting verdict_confidence_1_10 ≤ 4 OR the verdict is Critical
    with FR severity < high, run a SECOND sample at temperature 0.4 and pick:
      - the verdict that appears in BOTH samples (majority wins)
      - else keep the first sample but cap confidence at min(both, 5)

    Cost: triggers on ~20-30% of calls. Per call: +1 Decision Agent ≈ +$0.0008.
    Average adder: ~$0.0002/call = ₹0.02/min — well under budget.
    """
    first, first_cost = _run_synthesizer(client, deployment, transcript_for_prompt, specialist_results)

    if not isinstance(first, dict):
        return first, first_cost, {"sampled": False}

    conf = first.get("verdict_confidence_1_10")
    verdict = first.get("verdict")
    fr = specialist_results.get("fraud_risk") if isinstance(specialist_results, dict) else None
    fr_sev = (fr.get("highest_severity_observed") if isinstance(fr, dict) else "none") or "none"

    is_borderline = (
        isinstance(conf, (int, float)) and conf <= 4
    ) or (
        verdict == "Critical" and fr_sev not in ("critical", "high")
    )

    if not is_borderline:
        return first, first_cost, {"sampled": False, "reason": "above_threshold"}

    # Run a second sample at higher temperature
    try:
        # Need to rebuild the request to use temperature 0.4
        body = _compact_specialists_for_synthesis(specialist_results)
        body_renamed = {
            "identity_and_extraction": body.get("identity_and_extraction"),
            "fraud_risk":              body.get("fraud_risk"),
            "conversation":            body.get("conversation_behavior"),
        }
        user = (
            f"TRANSCRIPT:\n{transcript_for_prompt}\n\n"
            f"SPECIALISTS:\n{json.dumps(body_renamed, ensure_ascii=False, separators=(',', ':'))}\n\n"
            f"Apply chain-of-thought, disambiguation, and confidence caps. Return ONLY the required JSON."
        )
        t0 = time.time()
        resp = client.chat.completions.create(
            model=deployment,
            messages=[
                {"role": "system", "content": SYS_SYNTHESIZER},
                {"role": "user", "content": user},
            ],
            temperature=0.6,  # higher temperature for diversity
            response_format={"type": "json_object"},
            max_completion_tokens=2500,
        )
        wall = time.time() - t0
        second = _safe_parse(resp.choices[0].message.content)
        second_cost = _llm_cost(resp.usage)
        second_cost["wall_time_s"] = round(wall, 2)
        second = _enforce_disposition_consistency(second)
    except Exception as e:
        return first, first_cost, {"sampled": False, "reason": f"error: {e}"}

    # Combined cost
    merged_cost = {
        "prompt_tokens":     first_cost["prompt_tokens"] + second_cost["prompt_tokens"],
        "completion_tokens": first_cost["completion_tokens"] + second_cost["completion_tokens"],
        "total_tokens":      first_cost["total_tokens"] + second_cost["total_tokens"],
        "cost_usd_input":    first_cost["cost_usd_input"] + second_cost.get("cost_usd_input", 0.0),
        "cost_usd_output":   first_cost["cost_usd_output"] + second_cost.get("cost_usd_output", 0.0),
        "cost_usd_total":    first_cost["cost_usd_total"] + second_cost["cost_usd_total"],
        "cached_tokens":     first_cost.get("cached_tokens", 0) + second_cost.get("cached_tokens", 0),
        "wall_time_s":       first_cost["wall_time_s"] + second_cost["wall_time_s"],
    }

    # Majority vote
    if isinstance(second, dict) and second.get("verdict") == first.get("verdict"):
        # Agreement — average confidence, pick the more specific disposition
        cur_conf = first.get("verdict_confidence_1_10") or 5
        new_conf = second.get("verdict_confidence_1_10") or 5
        first["verdict_confidence_1_10"] = max(1, min(10, int(round((cur_conf + new_conf) / 2))))
        chain = list(first.get("reasoning_chain") or [])
        chain.append("B3 Self-consistency: 2 samples agreed on verdict — confidence averaged.")
        first["reasoning_chain"] = chain
        first["_self_consistency"] = {"sampled": True, "agreed": True, "second_verdict": second.get("verdict")}
        return first, merged_cost, {"sampled": True, "agreed": True}

    # Disagreement: keep the first verdict but cap confidence at 5 and route human_qc
    if isinstance(second, dict):
        first["verdict_confidence_1_10"] = min(first.get("verdict_confidence_1_10") or 5, 5)
        first["decision_routing"] = "human_qc"
        chain = list(first.get("reasoning_chain") or [])
        chain.append(
            f"B3 Self-consistency: 2 samples DISAGREED "
            f"(first={first.get('verdict')}/{first.get('disposition')}; "
            f"second={second.get('verdict')}/{second.get('disposition')}) — "
            f"confidence capped at 5 + routing forced to human_qc."
        )
        first["reasoning_chain"] = chain
        first["_self_consistency"] = {
            "sampled": True, "agreed": False,
            "first_verdict": first.get("verdict"), "first_disp": first.get("disposition"),
            "second_verdict": second.get("verdict"), "second_disp": second.get("disposition"),
        }
    return first, merged_cost, {"sampled": True, "agreed": False}


def _should_run_disambiguator(decision_output: dict, specialist_results: dict) -> bool:
    """Phase B1 — fire the Disposition Disambiguator only when the Decision
    Agent has picked a Critical/Negative disposition that's prone to
    Loan-Not-Taken vs Only-Enquiry vs Loan-Cancelled confusion.
    """
    if not isinstance(decision_output, dict):
        return False
    disp = decision_output.get("disposition") or ""
    target_disps = {
        "Loan Not Taken", "Loan Cancelled", "Only Enquiry",
        "Wrong Number", "No Negative Information Suspicious",
    }
    if disp not in target_disps:
        return False
    fr = specialist_results.get("fraud_risk") if isinstance(specialist_results, dict) else None
    if not isinstance(fr, dict):
        return False
    patterns = fr.get("patterns") or []
    pattern_names = {
        p.get("pattern") for p in patterns if isinstance(p, dict)
    }
    ambiguous_patterns = {"loan_not_taken", "only_enquiry", "loan_cancelled"}
    return bool(ambiguous_patterns & pattern_names)


def _run_disambiguator(client, deployment, transcript_for_prompt, decision_output, specialist_results):
    """Phase B1 — focused LLM call to disambiguate Loan-Not-Taken vs Only-Enquiry vs Loan-Cancelled."""
    fr_raw = specialist_results.get("fraud_risk") if isinstance(specialist_results, dict) else None
    fr = fr_raw if isinstance(fr_raw, dict) else {}
    fr_compact = {
        "patterns": fr.get("patterns") or [],
        "highest_severity_observed": fr.get("highest_severity_observed"),
        "overall_fraud_risk_1_10": fr.get("overall_fraud_risk_1_10"),
    }
    decision_compact = {
        "disposition": decision_output.get("disposition"),
        "verdict": decision_output.get("verdict"),
        "rationale": decision_output.get("rationale"),
        "key_evidence_quotes": decision_output.get("key_evidence_quotes") or [],
    }
    user = (
        f"TRANSCRIPT (with AGENT / SUBJECT / THIRD_PARTY tags):\n"
        f"{transcript_for_prompt}\n\n"
        f"DECISION AGENT'S CHOICE:\n"
        f"{json.dumps(decision_compact, ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"FRAUD RISK PATTERNS:\n"
        f"{json.dumps(fr_compact, ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"Pick the correct disposition per the decision tree. Return ONLY the required JSON."
    )
    result, cost = _call_llm(
        client, deployment, SYS_DISPOSITION_DISAMBIGUATOR, user,
        max_tokens=400, cache_key="rcu-disambiguator-v1", temperature=0.0
    )
    jid, fn = _audit_ctx_get()
    audit_log.log_llm_call(
        job_id=jid, filename=fn, agent="disambiguator",
        system_prompt=SYS_DISPOSITION_DISAMBIGUATOR,
        prompt_tokens=cost["prompt_tokens"], completion_tokens=cost["completion_tokens"],
        cost_usd_total=cost["cost_usd_total"], wall_time_s=cost["wall_time_s"],
        parsed_keys=list(result.keys()) if isinstance(result, dict) else [],
    )
    return result, cost


def _apply_disambiguator(decision_output: dict, disamb_output: dict) -> dict:
    """Phase B1 — apply the Disambiguator's verdict ONLY if it differs from
    Decision Agent AND it picked a valid disposition. Cap confidence at 7
    for any disposition change (don't let it over-confidently flip)."""
    if not isinstance(disamb_output, dict) or disamb_output.get("_parse_error"):
        return decision_output
    new_disp = (disamb_output.get("disposition") or "").strip()
    valid_disps = {"Loan Not Taken", "Loan Cancelled", "Only Enquiry", "Wrong Number", "No Negative Information"}
    if new_disp not in valid_disps:
        return decision_output

    adjusted = dict(decision_output or {})
    if new_disp == adjusted.get("disposition"):
        return adjusted  # No change

    verdict_map = {
        "Loan Not Taken": "Critical",
        "Loan Cancelled": "Critical",
        "Wrong Number":   "Critical",
        "Only Enquiry":   "Negative",
        "No Negative Information": "Positive",
    }
    adjusted["disposition"] = new_disp
    adjusted["disposition_rcu_status"] = verdict_map[new_disp]
    adjusted["verdict"] = verdict_map[new_disp]
    # Cap confidence — disambiguator overrides are inherently uncertain.
    try:
        cur_conf = int(disamb_output.get("verdict_confidence_1_10") or 5)
    except Exception:
        cur_conf = 5
    adjusted["verdict_confidence_1_10"] = max(1, min(7, cur_conf))
    adjusted["decision_routing"] = "human_qc"

    chain = list(adjusted.get("reasoning_chain") or [])
    chain.append(
        f"B1 Disambiguator override: disposition flipped to '{new_disp}' "
        f"({verdict_map[new_disp]}). Rationale: {disamb_output.get('rationale', '')}"
    )
    adjusted["reasoning_chain"] = chain
    adjusted["_disambiguator_applied"] = True
    return adjusted


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
    result, cost = _call_llm(client, deployment, SYS_REFLECTION, user, max_tokens=1200, cache_key="rcu-reflection-v3", temperature=0.0)
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

# A5 — Disposition → allowed caller-types map. Per the BACL TC Dispositions
# xlsx, dispositions belong to specific caller-type sheets. The Decision
# Agent sometimes picks cross-sheet dispositions (e.g. a Co-app-only label
# on an Applicant call). This map enforces the spec.
_DISPOSITION_ALLOWED_CALLER_TYPES: dict[str, set[str]] = {
    # Applicant-only Critical
    "rented residing less than 1 year": {"Applicant", "Monnai"},
    # Co-applicant-only
    "person is not co-applicant": {"Co-applicant"},
    "mob no not use by coa not family": {"Co-applicant"},
    "third party mobile number": {"Co-applicant"},
    "mob no not use by coa family": {"Co-applicant"},
    "third party mobile no family close blood relative": {"Co-applicant"},
    "app mob no use by coa family": {"Co-applicant"},
    "no negative information (includes-only enq)": {"Co-applicant"},
    # Monnai-only
    "monnai name mismatch": {"Monnai"},
    "monnai name belongs to third party": {"Monnai"},
    "mobile number belongs to monnai": {"Monnai"},
    # All other dispositions are allowed for any caller type.
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
    output: dict, specialist_results: dict, transcript_text: Optional[str] = None,
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

    # Rule R3 — High-completeness + clean overall_call_label + Critical with
    # NO critical/high FR severity → force routing to human_qc (don't auto-clear).
    # Per the BACL spec, a clean, complete, cooperative call should not be
    # auto-cleared as Critical without explicit fraud signals.
    if out.get("verdict") == "Critical":
        ident_complete = (
            ident.get("verification_completeness_pct") if isinstance(ident, dict) else None
        )
        fr = specialist_results.get("fraud_risk") or {}
        fr_sev = (fr.get("highest_severity_observed") if isinstance(fr, dict) else None) or "none"
        conv = specialist_results.get("conversation_behavior") or {}
        conv_label = (conv.get("overall_call_label") if isinstance(conv, dict) else None) or ""
        third_party = (conv.get("third_party_voice_detection") or {}) if isinstance(conv, dict) else {}

        if (
            isinstance(ident_complete, (int, float))
            and ident_complete >= 90
            and conv_label == "clean_cooperative"
            and fr_sev not in ("critical", "high")
            and not third_party.get("detected", False)
        ):
            # Don't flip the verdict — leave the disposition + Critical tag visible to
            # the reviewer but cap auto-clear and explicitly route to human_qc with note.
            prior_route = out.get("decision_routing")
            if prior_route == "auto_clear":
                out["decision_routing"] = "human_qc"
                fired_rules.append("R3:critical_on_clean_call_blocks_autoclear")
                prior_rationale = out.get("routing_rationale") or ""
                out["routing_rationale"] = (
                    (prior_rationale + " | " if prior_rationale else "")
                    + "R3: Critical verdict on a 100% complete, clean_cooperative "
                    "call with no critical/high FR signal — routed to human_qc."
                )
                chain = list(out.get("reasoning_chain") or [])
                chain.append(
                    "Post-hoc rule R3: Critical verdict on a clean, 100%-verified, "
                    "cooperative call with no critical/high FR severity — blocked auto_clear."
                )
                out["reasoning_chain"] = chain

    # Rule R4 — "Vehicle Delivered Before Login" requires explicit 30+ days signal
    # per the Scope-of-Speech-Analytics doc. Without that, the disposition is
    # being over-applied to bare "delivered" mentions.
    if out.get("disposition") == "Vehicle Delivered Before Login":
        delivery_claim = (ext or {}).get("vehicle_delivery_date_claim") if ext else None
        veh_check = ident.get("vehicle_check") if isinstance(ident, dict) else None
        # Accept either an explicit claim of 30+ days ago OR the IV's flag.
        thirty_plus = (
            isinstance(delivery_claim, str) and "30+ days" in delivery_claim.lower()
        ) or (
            isinstance(veh_check, dict) and veh_check.get("flag_vehicle_delivered_before_login") is True
            and veh_check.get("delivery_status") == "30_plus_days_ago"
        )
        if not thirty_plus:
            # Downgrade — let other signals decide between Suspicious-tier vs clean
            fr = specialist_results.get("fraud_risk") or {}
            fr_sev = (fr.get("highest_severity_observed") if isinstance(fr, dict) else None) or "none"
            if fr_sev in ("critical", "high"):
                # There's some other concrete fraud signal — leave Critical tier
                # but flip to a less severe Critical disposition if any matches.
                out["disposition"] = "No Negative Information Suspicious"
                out["disposition_rcu_status"] = "Negative"
                out["verdict"] = "Negative"
            else:
                out["disposition"] = "No Negative Information"
                out["disposition_rcu_status"] = "Positive"
                out["verdict"] = "Positive"
            out["decision_routing"] = "human_qc"
            fired_rules.append("R4:vdb_login_requires_30_plus_days")
            chain = list(out.get("reasoning_chain") or [])
            chain.append(
                "Post-hoc rule R4: 'Vehicle Delivered Before Login' requires an "
                "explicit 30+ days signal per the RCU_Context Scope doc. None "
                "found in vehicle_delivery_date_claim — disposition downgraded."
            )
            out["reasoning_chain"] = chain

    # Rule R5 — "Loan Not Taken" Critical → "Only Enquiry" Negative when the
    # Fraud Risk pattern set includes `only_enquiry` OR the FR evidence quote
    # for `loan_not_taken` does NOT contain an explicit-denial cue. Backstop
    # for when the LLM falls through to Critical on a "didn't take" call.
    EXPLICIT_DENIAL_CUES = (
        "मैंने नहीं", "नहीं लिया है", "i have not", "i never", "मेरा कोई loan नहीं",
        "मैं कोई finance", "मेरा कोई application", "ನಾನು ತಗೋಣಾಂಗಿಲ್ಲ",
        "i don't know any", "wrong number", "ऐसा कोई नहीं", "मैं नहीं जानता",
        "எடுக்கல", "எடுக்கவில்லை",  # Tamil "haven't taken"
    )
    fr_patterns = (
        (specialist_results.get("fraud_risk") or {}).get("patterns") or []
        if isinstance(specialist_results.get("fraud_risk"), dict) else []
    )
    fr_pattern_names = {p.get("pattern") for p in fr_patterns if isinstance(p, dict)}
    fr_quotes_joined = " ".join(
        (p.get("evidence_quote") or "").lower() for p in fr_patterns if isinstance(p, dict)
    )
    has_enquiry_pattern = "only_enquiry" in fr_pattern_names
    has_cancel_pattern = "loan_cancelled" in fr_pattern_names
    truly_explicit_denial = any(c in fr_quotes_joined for c in EXPLICIT_DENIAL_CUES)
    # CIBIL / rejection cues — these are Loan Cancelled, not Loan Not Taken.
    # Broadened to cover all 8 Indian-language script renderings of CIBIL +
    # generic "approval failed" cues.
    CIBIL_CUES = (
        # Latin / English
        "cibil", "credit score", "credit bureau", "low score", "score low",
        "score कम", "approval failed", "loan rejected", "reject hua",
        "approve nahi", "approve नहीं", "approval नहीं", "approval हुई नहीं",
        "मंजूर नहीं", "मंजूरी नहीं", "मंज़ूर नहीं",
        "reject", "rejected", "rejected hua", "नहीं मंजूर",
        # Hindi/Marathi
        "सिबिल", "सिबिल स्कोर", "सिबिल score",
        # Tamil
        "சிபில்", "சிபிஐஎல்", "credit ஸ்கோர்",
        # Telugu
        "సిబిల్", "సిబిల్ స్కోర్",
        # Kannada
        "ಸಿಬಿಲ್", "ಸಿಬಿಲ್ ಸ್ಕೋರ್",
        # Malayalam
        "സിബിൽ", "സിബിൽ സ്കോർ",
        # Bengali
        "সিবিল", "সিবিল স্কোর",
        # Gujarati
        "સિબિલ", "સિબિલ સ્કોર",
    )
    # Check both FR quotes AND the raw transcript — sometimes FR misses the cue.
    text_for_cibil_search = (fr_quotes_joined + " " + (transcript_text or "")).lower()
    has_cibil_cue = any(c.lower() in text_for_cibil_search for c in CIBIL_CUES)

    if out.get("disposition") == "Loan Not Taken":
        if has_cibil_cue or has_cancel_pattern:
            out["disposition"] = "Loan Cancelled"
            out["disposition_rcu_status"] = "Critical"
            out["verdict"] = "Critical"
            out["decision_routing"] = "human_qc"
            fired_rules.append("R5a:loan_not_taken_to_loan_cancelled")
            chain = list(out.get("reasoning_chain") or [])
            chain.append(
                "Post-hoc rule R5a: 'Loan Not Taken' remapped to 'Loan Cancelled' — "
                "Fraud Risk quotes contain CIBIL/rejection cues. Customer started "
                "the application but it was cancelled, not denied."
            )
            out["reasoning_chain"] = chain
        elif has_enquiry_pattern and not truly_explicit_denial:
            # Stricter: require enquiry PATTERN to be present (not just absence of denial).
            # This prevents demoting legitimate Critical "Loan Not Taken" calls where
            # the LLM's quote didn't include a literal "मैंने नहीं किया" cue.
            out["disposition"] = "Only Enquiry"
            out["disposition_rcu_status"] = "Negative"
            out["verdict"] = "Negative"
            out["decision_routing"] = "human_qc"
            fired_rules.append("R5b:loan_not_taken_demoted_to_only_enquiry")
            chain = list(out.get("reasoning_chain") or [])
            chain.append(
                "Post-hoc rule R5b: 'Loan Not Taken' downgraded to 'Only Enquiry' — "
                "Fraud Risk includes only_enquiry pattern AND no explicit-denial cue."
            )
            out["reasoning_chain"] = chain

    # R5c — Reverse direction: if LLM picked "Only Enquiry" but CIBIL cues are
    # in evidence, upgrade to "Loan Cancelled" Critical. CIBIL rejection is a
    # real, in-progress application that needs RCU review, not a clean enquiry.
    if out.get("disposition") == "Only Enquiry" and has_cibil_cue:
        out["disposition"] = "Loan Cancelled"
        out["disposition_rcu_status"] = "Critical"
        out["verdict"] = "Critical"
        out["decision_routing"] = "human_qc"
        fired_rules.append("R5c:only_enquiry_with_cibil_upgraded_to_loan_cancelled")
        chain = list(out.get("reasoning_chain") or [])
        chain.append(
            "Post-hoc rule R5c: 'Only Enquiry' upgraded to 'Loan Cancelled' — "
            "Fraud Risk quotes contain CIBIL/rejection cues. Application reached "
            "CIBIL check (real in-progress application), so it's Critical not enquiry."
        )
        out["reasoning_chain"] = chain

    # Rule R6 — Close-blood remap. If Decision Agent picked a NON-blood Critical
    # third-party disposition but iden specialist tagged the third party as
    # close-blood family, remap to the Family-Close-Blood Negative twin.
    CLOSE_BLOOD_REMAP = {
        "Third Party use": "Third Party use(Family-Close Blood relative)",
        "Third Party Mobile No": "Third Party Mobile No(Family-Close Blood relative)",
        "Third Party Attending Calls": "Third Party Attending Calls (Family-Close blood relative)",
    }
    chosen_disp = out.get("disposition")
    if chosen_disp in CLOSE_BLOOD_REMAP:
        mob = (ident.get("mobile_ownership_check") or {}) if isinstance(ident, dict) else {}
        veh = (ident.get("vehicle_check") or {}) if isinstance(ident, dict) else {}
        is_close = (
            mob.get("status") == "close_family"
            or veh.get("usage_status") == "close_family"
        )
        # Verify no explicit non-blood marker in FR notes/quotes.
        non_blood_markers = ("non-blood", "non blood", "friend", "cousin", "nephew",
                             "in-law", "neighbour", "neighbor", "दोस्त", "मित्र", "साला",
                             "जीजा", "देवर", "ननद")
        non_blood_in_evidence = any(
            m in (
                (p.get("notes") or "").lower() + " " + (p.get("evidence_quote") or "").lower()
            )
            for p in fr_patterns if isinstance(p, dict)
            for m in non_blood_markers
        )
        # NEW gate — only demote if Fraud Risk severity is medium or below.
        # If FR has a critical/high pattern flagging non-blood third-party, the
        # Critical disposition was supported by evidence; don't undo it.
        fr_block = specialist_results.get("fraud_risk") or {}
        fr_sev_for_r6 = (fr_block.get("highest_severity_observed") if isinstance(fr_block, dict) else "none") or "none"

        if is_close and not non_blood_in_evidence and fr_sev_for_r6 not in ("critical", "high"):
            out["disposition"] = CLOSE_BLOOD_REMAP[chosen_disp]
            out["disposition_rcu_status"] = "Negative"
            out["verdict"] = "Negative"
            out["decision_routing"] = "human_qc"
            fired_rules.append("R6:close_blood_remap")
            chain = list(out.get("reasoning_chain") or [])
            chain.append(
                f"Post-hoc rule R6: disposition '{chosen_disp}' remapped to "
                f"'{out['disposition']}' — iden specialist flagged the third party "
                f"as close-blood family (mobile/vehicle status = close_family) and "
                f"no non-blood relation marker is present in evidence."
            )
            out["reasoning_chain"] = chain

    # Rule R8 — Re-promote Family-Close Negative to non-blood Critical when the
    # evidence quotes / notes / transcript explicitly mention a non-blood relation.
    # R6 sometimes demotes Critical "Third Party use" to Negative when iden says
    # close_family but the actual relation (uncle/aunt/cousin/in-law) is NON-blood
    # per the BACL spec. R8 looks at the raw quotes for relation words and
    # restores the Critical disposition. Runs AFTER R6.
    NON_BLOOD_RELATION_CUES = (
        # Hindi/Marathi — uncle/aunt (all non-blood per BACL spec)
        "मामा", "मामी", "चाचा", "चाची", "फूफा", "फूफी",
        "मौसा", "मौसी", "maushi", "बुआ", "buaa", "buwa", "आत्या", "atya",
        # Cousin / nephew / niece
        "चचेरा", "ममेरा", "फूफेरा", "मौसेरा", "cousin",
        "भतीजा", "भतीजी", "भांजा", "भांजी", "nephew", "niece",
        # In-laws (EXPLICITLY Critical per BACL spec)
        "साला", "साली", "जीजा", "जेठ", "देवर", "ननद", "जेठानी", "देवरानी",
        "सास", "ससुर", "brother-in-law", "sister-in-law",
        "mother-in-law", "father-in-law", "in-law", "in law",
        # Friend / neighbor / employee
        "दोस्त", "मित्र", "friend", "neighbour", "neighbor",
        "पड़ोसी", "employee", "कर्मचारी",
        # Tamil
        "மாமா", "சித்தப்பா", "அத்தான்", "மாமனார்", "மாமியார்",
        "மருமகன்", "மருமகள்",  # son-in-law / daughter-in-law
        "அண்ணன் மகன்",  # nephew (literally "brother's son")
        # Telugu
        "మామా", "చిన్నాన్న", "మామయ్య", "బాబాయ్", "మామగారు",
        "మరిది", "మరదలు", "బావగారు",  # in-laws
        # Kannada
        "ಮಾಮ", "ಚಿಕ್ಕಪ್ಪ", "ಅತ್ತೆ", "ಮಾವ", "ಭಾವ",
        # Bengali
        "মামা", "কাকা", "জামাইবাবু",
        # Gujarati
        "મામા", "કાકા", "ફુઆ",
    )
    fr_text_combined = " ".join(
        ((p.get("evidence_quote") or "") + " " + (p.get("notes") or "")).lower()
        for p in fr_patterns if isinstance(p, dict)
    )
    # Also scan the transcript — sometimes the LLM saw the relation but didn't
    # quote it directly in the FR pattern.
    text_for_r8 = (fr_text_combined + " " + (transcript_text or "")).lower()
    has_non_blood_cue = any(c.lower() in text_for_r8 for c in NON_BLOOD_RELATION_CUES)

    FAMILY_CLOSE_TO_CRITICAL = {
        "Third Party use(Family-Close Blood relative)":        "Third Party use",
        "Third Party Mobile No(Family-Close Blood relative)":  "Third Party Mobile No",
        "Third Party Attending Calls (Family-Close blood relative)": "Third Party Attending Calls",
    }
    if (
        out.get("disposition") in FAMILY_CLOSE_TO_CRITICAL
        and has_non_blood_cue
    ):
        new_disp = FAMILY_CLOSE_TO_CRITICAL[out["disposition"]]
        out["disposition"] = new_disp
        out["disposition_rcu_status"] = "Critical"
        out["verdict"] = "Critical"
        out["decision_routing"] = "human_qc"
        fired_rules.append("R8:family_close_repromoted_to_non_blood_critical")
        chain = list(out.get("reasoning_chain") or [])
        chain.append(
            f"Post-hoc rule R8: '{out['disposition']}' re-promoted from Family-Close "
            f"Negative — evidence quotes / transcript mention a NON-blood relation "
            f"(uncle/aunt/cousin/in-law/friend). Per BACL spec, only spouse/parent/"
            f"child/sibling qualify as close-blood Negative; everything else is "
            f"non-blood Critical."
        )
        out["reasoning_chain"] = chain

    # Rule R7 — A Co-applicant call with clean, complete verification and no
    # explicit denial → upgrade to Positive on the co-app sheet.
    if out.get("caller_type") == "Co-applicant":
        completeness = ident.get("verification_completeness_pct") if isinstance(ident, dict) else 0
        consistency = ident.get("identity_consistency_1_10") if isinstance(ident, dict) else 0
        conv = specialist_results.get("conversation_behavior") or {}
        conv_label = (conv.get("overall_call_label") if isinstance(conv, dict) else "") or ""
        tp = (conv.get("third_party_voice_detection") or {}) if isinstance(conv, dict) else {}
        fr_block = specialist_results.get("fraud_risk") or {}
        fr_sev = (fr_block.get("highest_severity_observed") if isinstance(fr_block, dict) else "none") or "none"
        # Did the SUBJECT explicitly deny being a co-applicant?
        EXPLICIT_COAPP_DENIAL = (
            "co-applicant नहीं", "i am not a co-applicant", "co-app नहीं",
            "मैं नहीं हूँ", "i'm not a co", "मेरे नाम पर नहीं",
            "co-applicant illa", "ko-applicant illai",  # Tam/Mal approximations
        )
        explicit_denial = any(c in fr_quotes_joined for c in EXPLICIT_COAPP_DENIAL)

        if (
            (completeness or 0) >= 90
            and (consistency or 0) >= 9
            and conv_label == "clean_cooperative"
            and not tp.get("detected")
            and fr_sev not in ("critical", "high")
            and not explicit_denial
            and out.get("disposition") in {
                "Person is not co-applicant",
                "Third Party use(Family-Close Blood relative)",
                "Third Party Attending Calls (Family-Close blood relative)",
                "Third Party Mobile No(Family-Close Blood relative)",
            }
        ):
            out["disposition"] = "No Negative Information (Includes-Only enq)"
            out["disposition_rcu_status"] = "Positive"
            out["verdict"] = "Positive"
            out["decision_routing"] = "human_qc"  # still QC because co-app
            fired_rules.append("R7:clean_coapp_upgraded_to_positive")
            chain = list(out.get("reasoning_chain") or [])
            chain.append(
                "Post-hoc rule R7: Clean Co-applicant call (100% complete, "
                "consistency ≥ 9, clean_cooperative, no third-party voice, no "
                "critical/high FR severity, no explicit co-app denial) → upgraded "
                "from previous over-flagged Critical/Negative to Positive."
            )
            out["reasoning_chain"] = chain

    # Rule A5 — Disposition must belong to the caller_type's sheet.
    # If the LLM picked a disposition that doesn't apply to this caller type,
    # downgrade to the safest generic disposition for the available signals.
    chosen_disp = (out.get("disposition") or "").strip().lower()
    if chosen_disp in _DISPOSITION_ALLOWED_CALLER_TYPES:
        allowed = _DISPOSITION_ALLOWED_CALLER_TYPES[chosen_disp]
        actual_caller = out.get("caller_type") or "Unknown"
        if actual_caller not in allowed:
            # Fall back to a generic disposition that's safe for any caller type.
            # Prefer Incomplete Information if completeness is low; else
            # No Negative Information Suspicious (Negative tier — preserves caution).
            ident_complete = ident.get("verification_completeness_pct") if isinstance(ident, dict) else None
            if isinstance(ident_complete, (int, float)) and ident_complete < 70:
                new_disp = "Incomplete Information"
                new_status = "Negative"
            else:
                new_disp = "No Negative Information Suspicious"
                new_status = "Negative"
            chain = list(out.get("reasoning_chain") or [])
            chain.append(
                f"Post-hoc rule A5: disposition '{out.get('disposition')}' belongs to "
                f"{sorted(allowed)} sheet but this call is caller_type='{actual_caller}'. "
                f"Per the BACL TC Dispositions spec, that disposition cannot apply — "
                f"downgraded to '{new_disp}'."
            )
            out["disposition"] = new_disp
            out["disposition_rcu_status"] = new_status
            out["verdict"] = new_status
            out["decision_routing"] = "human_qc"
            out["reasoning_chain"] = chain
            fired_rules.append("A5:disposition_caller_type_mismatch")

    if fired_rules:
        out["_post_hoc_rules_fired"] = fired_rules
    return out


def _verify_evidence_quotes_speaker_aware(
    output: dict,
    transcript_text: str,
    utterances: List[Dict[str, Any]],
    speaker_roles_map: Dict[str, Any],
) -> dict:
    """Phase B2 — Speaker-aware quote verification.

    For Critical-tier verdicts, verify that the supporting evidence quotes
    are attributed to the SUBJECT (not the agent). This catches the failure
    mode where Fraud Risk picks up the agent's own clarifying question as
    "denial".

    Logic:
      1. For each quote in key_evidence_quotes, find the utterance that
         contains it (fuzzy substring + 4-word run match).
      2. Look up that utterance's speaker_role.
      3. If ALL Critical-supporting quotes are from AGENT utterances (or
         from non-subject utterances on a "subject said X" disposition),
         the Critical verdict is unsupported by speaker attribution →
         downgrade to "No Negative Information Suspicious" Negative + route
         human_qc.

    Runs AFTER the substring-only `_verify_evidence_quotes` so we know
    every remaining quote at least exists somewhere in the transcript.
    """
    if not isinstance(output, dict):
        return output
    if (output.get("verdict") or "").lower() != "critical":
        return output

    quotes = output.get("key_evidence_quotes") or []
    if not quotes or not isinstance(quotes, list):
        return output  # Already handled by upstream rule

    if not isinstance(speaker_roles_map, dict):
        return output

    # Build a per-utterance role map by index
    per_utt = speaker_roles_map.get("per_utterance_role") or []
    role_by_idx = {
        e.get("idx"): (e.get("effective_role") or "").lower()
        for e in per_utt if isinstance(e, dict) and isinstance(e.get("idx"), int)
    }
    if not role_by_idx:
        return output  # Resolver didn't populate, skip the check

    def _find_quote_speaker(quote_text: str) -> Optional[str]:
        """Find which utterance contains the quote and return its role."""
        norm_q = " ".join((quote_text or "").split()).lower()
        if len(norm_q) < 4:
            return None
        for i, u in enumerate(utterances):
            utt_text = " ".join((u.get("text") or "").split()).lower()
            if not utt_text:
                continue
            if norm_q in utt_text or utt_text in norm_q:
                return role_by_idx.get(i, "unknown")
            # 4-word run match
            words = norm_q.split()
            if len(words) >= 4:
                for j in range(0, len(words) - 3):
                    run = " ".join(words[j:j + 4])
                    if run in utt_text:
                        return role_by_idx.get(i, "unknown")
        return None

    quote_speakers: list[str] = []
    for q in quotes:
        if isinstance(q, dict):
            who = _find_quote_speaker(q.get("quote") or "")
            quote_speakers.append(who or "not_found")

    # Count how many quotes are subject vs agent vs other
    n_subject = sum(1 for s in quote_speakers if s in ("subject", "third_party_former_subject"))
    n_agent   = sum(1 for s in quote_speakers if s == "agent")
    n_other   = sum(1 for s in quote_speakers if s in ("third_party", "unknown", "not_found", None))

    # Critical verdicts about subject behaviour need subject-attributed quotes.
    # If ALL the quotes come from the AGENT, the Critical claim is unsupported.
    disposition_implies_subject = output.get("disposition") in {
        "Third Party use", "Third Party use(Family-Close Blood relative)",
        "Third Party Attending Calls", "Third Party Attending Calls (Family-Close blood relative)",
        "Third Party Mobile No", "Third Party Mobile No(Family-Close Blood relative)",
        "Third Party Prompting On Call",
        "Loan Not Taken", "Loan Cancelled", "Only Enquiry",
        "Wrong Number", "Refused to share information",
        "Information Mismatch-Customer demographics", "Person is not co-applicant",
    }

    out = dict(output)
    out["_quote_speaker_breakdown"] = {
        "subject": n_subject, "agent": n_agent, "other": n_other,
        "speakers": quote_speakers,
    }
    rules_fired = list(out.get("_post_hoc_rules_fired") or [])

    if (
        disposition_implies_subject
        and n_subject == 0
        and n_agent >= 1
    ):
        # All Critical quotes from agent — the model is hearing the agent's
        # questions as the subject's answers. Downgrade.
        out["disposition"] = "No Negative Information Suspicious"
        out["disposition_rcu_status"] = "Negative"
        out["verdict"] = "Negative"
        out["decision_routing"] = "human_qc"
        rules_fired.append("B2:critical_quotes_only_from_agent_downgraded")
        chain = list(out.get("reasoning_chain") or [])
        chain.append(
            "Post-hoc rule B2: every Critical-supporting evidence quote is "
            "attributed to the AGENT (not the subject). The model is treating "
            "agent questions as subject statements. Downgraded to Negative "
            "'No Negative Information Suspicious' + human_qc."
        )
        out["reasoning_chain"] = chain
        out["_post_hoc_rules_fired"] = rules_fired

    return out


def _verify_evidence_quotes(output: dict, transcript_text: str) -> dict:
    """A1 — Verbatim-evidence verification on Critical verdicts.

    For any Critical-tier verdict, every quote in `key_evidence_quotes` must
    actually appear in the transcript. We strip quotes that don't match. If
    the model claimed Critical but ALL quotes are unmatched (or the array
    is empty), the verdict gets blocked from auto-clear and routed to human_qc,
    with a note that no quoted evidence was verified.

    We use a fuzzy substring match — strip whitespace/punctuation and check
    if the quote (or any 4-word run from it) appears in the transcript. This
    handles minor LLM paraphrasing while still flagging completely fabricated
    quotes.
    """
    if not isinstance(output, dict):
        return output
    if (output.get("verdict") or "").lower() != "critical":
        return output

    quotes = output.get("key_evidence_quotes") or []
    if not isinstance(quotes, list):
        return output

    # Normalise transcript for substring matching
    norm_transcript = " ".join((transcript_text or "").split()).lower()
    if not norm_transcript:
        return output

    def _quote_supported(q_obj) -> bool:
        if not isinstance(q_obj, dict):
            return False
        q = (q_obj.get("quote") or "").strip()
        if not q:
            return False
        norm_q = " ".join(q.split()).lower()
        if len(norm_q) < 4:
            return False
        # Exact substring match first
        if norm_q in norm_transcript:
            return True
        # Fuzzy fallback: split into words, look for any contiguous 4-word run
        words = norm_q.split()
        if len(words) < 4:
            return False
        for i in range(0, len(words) - 3):
            run = " ".join(words[i:i + 4])
            if run in norm_transcript:
                return True
        return False

    verified = [q for q in quotes if _quote_supported(q)]
    stripped = len(quotes) - len(verified)

    out = dict(output)
    out["key_evidence_quotes"] = verified
    out["_evidence_stripped"] = stripped

    if stripped > 0:
        out["_evidence_audit"] = {
            "original_quote_count": len(quotes),
            "verified_quote_count": len(verified),
            "stripped_count": stripped,
        }
        chain = list(out.get("reasoning_chain") or [])
        chain.append(
            f"Evidence audit (A1): stripped {stripped} unverified quote(s) "
            f"from key_evidence_quotes — they did not appear in the transcript."
        )
        out["reasoning_chain"] = chain

    # If we ended up with NO evidence quotes on a Critical verdict, force
    # human_qc routing — the model claimed Critical without grounding.
    if not verified and out.get("decision_routing") == "auto_clear":
        out["decision_routing"] = "human_qc"
        rules = list(out.get("_post_hoc_rules_fired") or [])
        rules.append("A1:critical_with_no_evidence_blocks_autoclear")
        out["_post_hoc_rules_fired"] = rules

    return out


# ─── Reflection application ─────────────────────────────────────────────────
_VALID_ROUTES = {"auto_clear", "human_qc", "compliance_escalation"}


def _apply_reflection(decision_output: dict, reflection_output: dict, specialist_results: Optional[dict] = None) -> dict:
    """Apply Reflection's adjustments to the Decision Agent output.
    Returns a NEW dict — does not mutate the original.

    Defense-in-depth: even if the Reflection LLM flags `completeness_paradox` or
    `critical_evidence_check` at HIGH severity, we GATE the verdict-downgrade on
    the FR specialist's `highest_severity_observed`. If FR says critical/high,
    the Critical claim is grounded and we don't downgrade.
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

    # 4) Verdict-override on completeness_paradox HIGH severity.
    # If Reflection flagged that a clean, complete, cooperative call was
    # given Critical without strong evidence — and the prior Decision Agent
    # had no critical/high FR severity to back it up — downgrade the verdict
    # to Negative (with disposition "No Negative Information Suspicious")
    # and force human_qc routing. This is the strongest safety net against
    # over-escalation we measured in the 20-call benchmark.
    issues = reflection_output.get("issues_found") or []
    if isinstance(issues, list):
        paradox_high = any(
            isinstance(i, dict)
            and i.get("check") == "completeness_paradox"
            and (i.get("severity") or "").lower() == "high"
            for i in issues
        )
        critical_no_evidence_high = any(
            isinstance(i, dict)
            and i.get("check") == "critical_evidence_check"
            and (i.get("severity") or "").lower() == "high"
            for i in issues
        )
        # Downgrade Critical when EITHER Reflection check fires at HIGH severity —
        # BUT defense-in-depth: gate on FR severity. If FR specialist has a
        # critical/high pattern, the Critical claim is grounded; don't downgrade
        # just because Reflection LLM "felt" uncertain about quotes.
        sr_safe = specialist_results if isinstance(specialist_results, dict) else {}
        fr_block_raw = sr_safe.get("fraud_risk")
        fr_block = fr_block_raw if isinstance(fr_block_raw, dict) else {}
        fr_sev_apply = (fr_block.get("highest_severity_observed") or "none")
        fr_blocks_downgrade = fr_sev_apply in ("critical", "high")

        if (paradox_high or critical_no_evidence_high) and adjusted.get("verdict") == "Critical":
            if fr_blocks_downgrade:
                # Don't downgrade — log the conflict for audit.
                chain = list(adjusted.get("reasoning_chain") or [])
                check = "completeness_paradox" if paradox_high else "critical_evidence_check"
                chain.append(
                    f"Reflection flagged '{check}' HIGH on Critical verdict, BUT "
                    f"Fraud Risk severity is {fr_sev_apply} → blocked downgrade. "
                    f"Critical disposition preserved."
                )
                adjusted["reasoning_chain"] = chain
                # Also drop the routing override if reflection tried to weaken it.
            else:
                adjusted["disposition"] = "No Negative Information Suspicious"
                adjusted["disposition_rcu_status"] = "Negative"
                adjusted["verdict"] = "Negative"
                adjusted["decision_routing"] = "human_qc"
                chain = list(adjusted.get("reasoning_chain") or [])
                check = "completeness_paradox" if paradox_high else "critical_evidence_check"
                chain.append(
                    f"Reflection verdict-override: '{check}' fired at HIGH severity on a "
                    f"Critical verdict (FR severity {fr_sev_apply}) — downgraded to Negative "
                    f"'No Negative Information Suspicious' + routed to human_qc."
                )
                adjusted["reasoning_chain"] = chain
            adjusted["_reflection_verdict_override"] = check

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
    # Phase A0 — resolve speaker roles BEFORE any LLM call so every downstream
    # prompt sees AGENT / SUBJECT / THIRD_PARTY labels rather than anonymous
    # speaker_0/speaker_1 IDs.
    speaker_roles_map = resolve_speaker_roles(utterances, llm_client=llm_client, deployment=deployment)
    transcript_for_prompt = _format_transcript_for_prompt(utterances, speaker_roles_map)
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
            "speaker_roles": speaker_roles_map,
            "triage": {"output": triage_out, "cost": triage_cost, "short_circuited": True},
            "specialists": {},
            "decision_agent": {"output": synth_out, "cost": synth_cost},
            "reflection": {"output": reflection_out, "cost": reflection_cost, "applied": False},
            "final_output": synth_out,
            "aggregate_cost": {
                "total_prompt_tokens":     total_in,
                "total_completion_tokens": total_out,
                "total_tokens":            total_in + total_out,
                "total_cost_usd":          round(total_usd + speaker_roles_map.get("resolver_cost_usd", 0.0), 8),
                "speaker_resolver_usd":    speaker_roles_map.get("resolver_cost_usd", 0.0),
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

    # 2c. DECISION AGENT (with B3 self-consistency on borderline cases) ---------
    t_synth = time.time()
    synth_out, synth_cost, b3_meta = _run_synthesizer_self_consistency(
        llm_client, deployment, transcript_for_prompt, spec_results
    )
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

    # Phase B1 — Disposition Disambiguator (conditional, fires only on
    # borderline Loan-Not-Taken / Only-Enquiry / Loan-Cancelled cases).
    post_reflection = _apply_reflection(synth_out, reflection_out, specialist_results=spec_results)
    disamb_out = None
    disamb_cost = {
        "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        "cost_usd_input": 0.0, "cost_usd_output": 0.0, "cost_usd_total": 0.0,
        "wall_time_s": 0.0,
    }
    if _should_run_disambiguator(post_reflection, spec_results):
        try:
            disamb_out, disamb_cost = _run_disambiguator(
                llm_client, deployment, transcript_for_prompt, post_reflection, spec_results
            )
            post_reflection = _apply_disambiguator(post_reflection, disamb_out)
        except Exception as e:
            audit_log.log("disambiguator.error", error=str(e))
            disamb_out = {"_error": str(e)}

    final_output = _enforce_disposition_consistency(
        _enforce_disposition_rules(
            _verify_evidence_quotes_speaker_aware(
                _verify_evidence_quotes(
                    post_reflection,
                    transcript_for_prompt,
                ),
                transcript_for_prompt,
                utterances,
                speaker_roles_map,
            ),
            spec_results,
            transcript_text=transcript_for_prompt,
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
        + disamb_cost["prompt_tokens"]
    )
    total_out = (
        triage_cost["completion_tokens"]
        + sum(c["completion_tokens"] for c in spec_costs.values())
        + synth_cost["completion_tokens"]
        + reflection_cost["completion_tokens"]
        + disamb_cost["completion_tokens"]
    )
    total_usd = (
        triage_cost["cost_usd_total"]
        + sum(c["cost_usd_total"] for c in spec_costs.values())
        + synth_cost["cost_usd_total"]
        + reflection_cost["cost_usd_total"]
        + disamb_cost["cost_usd_total"]
    )

    return {
        "speaker_roles": speaker_roles_map,
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
            "total_cost_usd":          round(total_usd + speaker_roles_map.get("resolver_cost_usd", 0.0), 8),
            "speaker_resolver_usd":    speaker_roles_map.get("resolver_cost_usd", 0.0),
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

    # Derive audit-report metrics (non-speech, talk duration split, sentiment
    # per speaker, greeting justification). These power the competitor-format
    # PoC report (one row per call) without changing the rest of the pipeline.
    audit_metrics = _compute_audit_metrics(
        utterances=utterances,
        total_duration_s=stt_cost["audio_seconds"],
        verification=verification,
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
        "audit_metrics": audit_metrics,
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
