"""Structured JSONL audit logger.

Every meaningful pipeline event (STT request, LLM call, disposition decision,
post-hoc rule firing, reflection adjustment) writes one line to a daily
JSONL file under ``logs/``. The file format is one JSON object per line so
it can be grepped, tailed live, or loaded straight into pandas/jq for
post-hoc analysis.

Disabled if `AUDIT_LOG_DISABLED=1` in the env. Otherwise on by default.
"""
from __future__ import annotations
import hashlib
import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_DEFAULT_LOG_DIR = Path(os.environ.get("AUDIT_LOG_DIR") or "logs")
_DISABLED = os.environ.get("AUDIT_LOG_DISABLED") == "1"
_lock = threading.Lock()


def _ensure_dir() -> Path:
    _DEFAULT_LOG_DIR.mkdir(parents=True, exist_ok=True)
    return _DEFAULT_LOG_DIR


def _log_path() -> Path:
    """One JSONL file per UTC day. Easy to ship to S3/blob later."""
    d = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return _ensure_dir() / f"audit-{d}.jsonl"


def _hash(text: str) -> str:
    return hashlib.sha1((text or "").encode("utf-8")).hexdigest()[:12]


def log(event_type: str, **fields: Any) -> None:
    """Append one structured event to today's audit log file.

    ``event_type`` is a short kebab-case key (e.g. "stt.request", "llm.call",
    "disposition.decided", "rule.fired"). Everything else is free-form
    keyword fields that get serialised into the JSON line.
    """
    if _DISABLED:
        return
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event_type,
        **fields,
    }
    try:
        line = json.dumps(entry, ensure_ascii=False, default=str)
    except Exception as e:
        # If something inside fields wasn't JSON-serialisable, still log a
        # truncated record so the failure itself is captured.
        line = json.dumps({
            "ts": entry["ts"],
            "event": event_type,
            "serialisation_error": str(e),
            "field_keys": list(fields.keys()),
        }, ensure_ascii=False)
    with _lock:
        try:
            with _log_path().open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception as e:
            # Never break the pipeline because of logging.
            print(f"[audit_log] failed to write entry: {e}", file=sys.stderr)


def log_llm_call(
    *,
    job_id: str | None,
    filename: str | None,
    agent: str,
    system_prompt: str,
    prompt_tokens: int,
    completion_tokens: int,
    cost_usd_total: float,
    wall_time_s: float,
    parsed_keys: list[str] | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    """Convenience wrapper for the most common event — an LLM agent call.

    Captures the metadata needed for cost / cache / quality analysis:
    token counts, latency, system-prompt hash (so we can verify caching
    opportunity = identical prefix across calls), and the top-level keys
    of the parsed JSON response (without the full payload to keep logs
    light)."""
    log(
        "llm.call",
        job_id=job_id,
        filename=filename,
        agent=agent,
        system_prompt_sha1=_hash(system_prompt),
        system_prompt_tokens_approx=len(system_prompt) // 4,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        cost_usd_total=round(cost_usd_total, 8),
        wall_time_s=round(wall_time_s, 3),
        parsed_keys=parsed_keys or [],
        **(extra or {}),
    )


def log_stt_call(
    *,
    job_id: str | None,
    filename: str | None,
    provider: str,
    audio_duration_s: float,
    language_code: str | None,
    language_probability: float | None,
    num_words: int,
    num_speakers: int,
    cost_usd_total: float,
    wall_time_s: float,
    extra: dict[str, Any] | None = None,
) -> None:
    log(
        "stt.call",
        job_id=job_id,
        filename=filename,
        provider=provider,
        audio_duration_s=round(audio_duration_s, 2),
        language_code=language_code,
        language_probability=language_probability,
        num_words=num_words,
        num_speakers=num_speakers,
        cost_usd_total=round(cost_usd_total, 8),
        wall_time_s=round(wall_time_s, 3),
        **(extra or {}),
    )


def log_decision(
    *,
    job_id: str | None,
    filename: str | None,
    verdict: str | None,
    disposition: str | None,
    disposition_rcu_status: str | None,
    caller_type: str | None,
    confidence: int | None,
    routing: str | None,
    risk_tags: list[str] | None,
    reflection_applied: bool,
    confidence_delta: int | None,
    routing_override: str | None,
    post_hoc_rules_fired: list[str] | None,
    extra: dict[str, Any] | None = None,
) -> None:
    log(
        "disposition.decided",
        job_id=job_id,
        filename=filename,
        verdict=verdict,
        disposition=disposition,
        disposition_rcu_status=disposition_rcu_status,
        caller_type=caller_type,
        confidence=confidence,
        routing=routing,
        risk_tags=risk_tags or [],
        reflection_applied=bool(reflection_applied),
        confidence_delta=confidence_delta,
        routing_override=routing_override,
        post_hoc_rules_fired=post_hoc_rules_fired or [],
        **(extra or {}),
    )
