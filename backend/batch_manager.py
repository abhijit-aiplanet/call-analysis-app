"""In-memory batch job manager.

Each job tracks N files going through the full Scribe v2 + multi-agent pipeline.
The submitting HTTP request returns immediately with a job_id; processing
runs in a background thread pool. Clients poll GET /batch/{job_id} to track
progress and retrieve results.

For production at >>20K calls/month we'd swap this for Redis + a real queue
(Celery / RQ / Cloud Tasks). For now in-memory suffices.
"""
from __future__ import annotations
import os, uuid, tempfile, threading, traceback
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any

from elevenlabs import ElevenLabs
from openai import AzureOpenAI

from pipeline import analyze_call_end_to_end


# ─── Tunable concurrency ────────────────────────────────────────────────────
# Number of files processed in parallel per batch.
# Conservative for free/standard ElevenLabs tier; bump to 10-20 on Business+.
MAX_FILES_IN_FLIGHT = 5

# Number of batches that can be queued for background execution simultaneously.
# Each batch uses up to MAX_FILES_IN_FLIGHT internal workers, so total peak
# ElevenLabs concurrency is MAX_FILES_IN_FLIGHT * MAX_CONCURRENT_BATCHES.
MAX_CONCURRENT_BATCHES = 3


# ─── State containers ───────────────────────────────────────────────────────
@dataclass
class FileEntry:
    filename: str
    file_size_bytes: int
    status: str = "queued"        # queued / running_stt / running_sentiment / ok / error
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    error: Optional[str] = None
    error_type: Optional[str] = None
    result: Optional[Dict[str, Any]] = None    # full AnalysisRecord when status=ok
    wall_time_s: Optional[float] = None


@dataclass
class BatchJob:
    job_id: str
    status: str = "queued"        # queued / running / completed / completed_with_errors / failed / cancelled
    keyterms: List[str] = field(default_factory=list)
    created_at: str = ""
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    file_count: int = 0
    files: List[FileEntry] = field(default_factory=list)
    aggregate_cost: Optional[Dict[str, Any]] = None

    def public_dict(self) -> Dict[str, Any]:
        completed = sum(1 for f in self.files if f.status == "ok")
        failed    = sum(1 for f in self.files if f.status == "error")
        running   = sum(1 for f in self.files if f.status in ("running_stt", "running_sentiment"))
        queued    = sum(1 for f in self.files if f.status == "queued")
        return {
            "job_id":          self.job_id,
            "status":          self.status,
            "keyterms":        self.keyterms,
            "created_at":      self.created_at,
            "started_at":      self.started_at,
            "completed_at":    self.completed_at,
            "file_count":      self.file_count,
            "completed_count": completed,
            "failed_count":    failed,
            "running_count":   running,
            "queued_count":    queued,
            "progress_pct":    round(100 * (completed + failed) / max(self.file_count, 1), 1),
            "files":           [asdict(f) for f in self.files],
            "aggregate_cost":  self.aggregate_cost,
        }


# ─── Module-level shared state ─────────────────────────────────────────────
_jobs: Dict[str, BatchJob] = {}
_jobs_lock = threading.Lock()

# Pool that owns one slot per batch — each batch runs in its own background
# thread; inside that thread the batch spins up its own file-level pool.
_batch_executor = ThreadPoolExecutor(
    max_workers=MAX_CONCURRENT_BATCHES,
    thread_name_prefix="batch-worker",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _update_job(job_id: str, **fields):
    with _jobs_lock:
        if job_id in _jobs:
            for k, v in fields.items():
                setattr(_jobs[job_id], k, v)


def _update_file(job_id: str, file_idx: int, **fields):
    with _jobs_lock:
        if job_id in _jobs and 0 <= file_idx < len(_jobs[job_id].files):
            for k, v in fields.items():
                setattr(_jobs[job_id].files[file_idx], k, v)


# ─── Aggregate cost computation ─────────────────────────────────────────────
def _compute_aggregate(job: BatchJob, wall_start_ts: float, wall_end_ts: float) -> Dict[str, Any]:
    ok_files = [f for f in job.files if f.status == "ok" and f.result]
    err_files = [f for f in job.files if f.status == "error"]

    if not ok_files:
        return {
            "total_files":           job.file_count,
            "completed_files":       0,
            "failed_files":          len(err_files),
            "total_audio_seconds":   0,
            "total_audio_minutes":   0,
            "total_audio_hours":     0,
            "total_stt_usd":         0.0,
            "total_verification_usd": 0.0,
            "total_pipeline_usd":    0.0,
            "avg_cost_per_call_usd":          0.0,
            "avg_cost_per_minute_audio_usd":  0.0,
            "verdict_distribution":  {},
            "wall_time_seconds":   round(wall_end_ts - wall_start_ts, 2),
        }

    total_audio_s = sum(f.result["audio_meta"]["audio_duration_s"] for f in ok_files)
    total_stt     = sum(f.result["unified_cost"]["stt_usd"]          for f in ok_files)
    total_verif   = sum(f.result["unified_cost"]["verification_usd"] for f in ok_files)
    total_pipe    = sum(f.result["unified_cost"]["total_usd"]        for f in ok_files)

    # Verdict distribution across the batch — useful for batch summary view.
    from collections import Counter
    verdicts = Counter(
        (f.result.get("rcu_verdict") or {}).get("verdict") or "Unknown"
        for f in ok_files
    )

    audio_minutes = total_audio_s / 60
    return {
        "total_files":           job.file_count,
        "completed_files":       len(ok_files),
        "failed_files":          len(err_files),
        "total_audio_seconds":   round(total_audio_s, 2),
        "total_audio_minutes":   round(audio_minutes, 4),
        "total_audio_hours":     round(audio_minutes / 60, 6),
        "total_stt_usd":         round(total_stt, 8),
        "total_verification_usd": round(total_verif, 8),
        "total_pipeline_usd":    round(total_pipe, 8),
        "avg_cost_per_call_usd":          round(total_pipe / max(len(ok_files), 1), 8),
        "avg_cost_per_minute_audio_usd":  round(total_pipe / max(audio_minutes, 1e-9), 8) if audio_minutes > 0 else None,
        "verdict_distribution":  dict(verdicts),
        "wall_time_seconds":   round(wall_end_ts - wall_start_ts, 2),
        "audio_minutes_per_wall_minute":  round(
            (audio_minutes * 60) / max(wall_end_ts - wall_start_ts, 1e-9), 2
        ),
    }


# ─── Per-file worker ────────────────────────────────────────────────────────
def _process_one_file(
    job_id: str,
    file_idx: int,
    filename: str,
    content: bytes,
    keyterms: List[str],
    eleven_client: ElevenLabs,
    llm_client: AzureOpenAI,
    deployment: str,
):
    """Runs in a file-level thread. Writes a temp file, calls the pipeline,
    updates job state when done."""
    import time
    t_start = time.time()
    _update_file(job_id, file_idx, status="running_stt", started_at=_now())

    suffix = os.path.splitext(filename or "")[1] or ".mp3"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)

        # Bridge between stages: mark as sentiment-running after STT-ish phase
        # (we can't observe the exact transition without re-instrumenting the pipeline,
        # so we approximate by setting it right before the call returns)
        result = analyze_call_end_to_end(
            audio_path=tmp_path,
            eleven_client=eleven_client,
            llm_client=llm_client,
            llm_deployment=deployment,
            keyterms=keyterms,
            job_id=job_id,
        )
        # Replace temp filename with the original upload name
        result["filename"] = filename or result.get("filename")

        _update_file(
            job_id, file_idx,
            status="ok",
            result=result,
            completed_at=_now(),
            wall_time_s=round(time.time() - t_start, 2),
        )

    except Exception as e:
        _update_file(
            job_id, file_idx,
            status="error",
            error=f"{type(e).__name__}: {e}",
            error_type=type(e).__name__,
            completed_at=_now(),
            wall_time_s=round(time.time() - t_start, 2),
        )

    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


# ─── Per-batch worker ───────────────────────────────────────────────────────
def _process_batch(
    job_id: str,
    audio_data: List[tuple],     # list of (filename, bytes)
    keyterms: List[str],
    eleven_client: ElevenLabs,
    llm_client: AzureOpenAI,
    deployment: str,
):
    """Runs in _batch_executor. Spins up a file-level pool to process the
    batch's files in parallel."""
    import time
    wall_start = time.time()
    _update_job(job_id, status="running", started_at=_now())

    try:
        with ThreadPoolExecutor(
            max_workers=MAX_FILES_IN_FLIGHT,
            thread_name_prefix=f"batch-{job_id[:6]}-file",
        ) as pool:
            futures = []
            for i, (filename, content) in enumerate(audio_data):
                fut = pool.submit(
                    _process_one_file,
                    job_id, i, filename, content,
                    keyterms, eleven_client, llm_client, deployment,
                )
                futures.append(fut)
            # Wait for all
            for fut in futures:
                fut.result()  # surface exceptions, though _process_one_file catches them

        wall_end = time.time()

        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is None:
                return
            job.aggregate_cost = _compute_aggregate(job, wall_start, wall_end)
            ok = sum(1 for f in job.files if f.status == "ok")
            err = sum(1 for f in job.files if f.status == "error")
            if err == 0:
                job.status = "completed"
            elif ok == 0:
                job.status = "failed"
            else:
                job.status = "completed_with_errors"
            job.completed_at = _now()

    except Exception as e:
        _update_job(
            job_id,
            status="failed",
            completed_at=_now(),
            aggregate_cost={
                "error": f"{type(e).__name__}: {e}",
                "traceback": traceback.format_exc(),
            },
        )


# ─── Public API ─────────────────────────────────────────────────────────────
def create_batch(
    audio_data: List[tuple],     # list of (filename, bytes)
    keyterms: List[str],
    eleven_client: ElevenLabs,
    llm_client: AzureOpenAI,
    deployment: str,
) -> str:
    """Register a new batch job and kick off background processing.
    Returns the new job_id."""
    job_id = str(uuid.uuid4())
    job = BatchJob(
        job_id=job_id,
        keyterms=list(keyterms),
        created_at=_now(),
        file_count=len(audio_data),
        files=[
            FileEntry(filename=fn, file_size_bytes=len(content))
            for fn, content in audio_data
        ],
    )
    with _jobs_lock:
        _jobs[job_id] = job

    _batch_executor.submit(
        _process_batch,
        job_id, audio_data, keyterms,
        eleven_client, llm_client, deployment,
    )
    return job_id


def get_batch(job_id: str) -> Optional[Dict[str, Any]]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        return job.public_dict()


def list_recent_batches(limit: int = 20) -> List[Dict[str, Any]]:
    with _jobs_lock:
        all_jobs = sorted(_jobs.values(), key=lambda j: j.created_at, reverse=True)[:limit]
        # Strip per-file results to keep payload small
        return [
            {
                "job_id":          j.job_id,
                "status":          j.status,
                "created_at":      j.created_at,
                "file_count":      j.file_count,
                "completed_count": sum(1 for f in j.files if f.status == "ok"),
                "failed_count":    sum(1 for f in j.files if f.status == "error"),
                "total_usd":       (j.aggregate_cost or {}).get("total_pipeline_usd"),
            }
            for j in all_jobs
        ]


def delete_batch(job_id: str) -> bool:
    with _jobs_lock:
        if job_id in _jobs:
            del _jobs[job_id]
            return True
        return False
