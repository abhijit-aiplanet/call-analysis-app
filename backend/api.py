"""FastAPI service for the Bajaj Auto Credit call-analysis pipeline.

Production entry point. Reads PORT and ALLOWED_ORIGINS from the environment
so it deploys cleanly to Render / Railway / Fly.io / any container host.

Endpoints:
  GET  /health                — liveness + credential status
  GET  /pricing               — current rate card (for UI display)
  POST /analyze               — single-file synchronous analysis
  POST /batch                 — multi-file batch (returns job_id immediately)
  GET  /batch/{job_id}        — poll status + per-file results
  GET  /batches               — recent batch jobs (lightweight)
  DELETE /batch/{job_id}      — free a completed job from memory
"""
from __future__ import annotations
import os, sys, tempfile
from typing import List, Optional
from datetime import datetime

import dotenv
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from elevenlabs import ElevenLabs
from openai import AzureOpenAI

# Same-dir imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline import analyze_call_end_to_end, RATE_CARD
from batch_manager import (
    create_batch, get_batch, list_recent_batches, delete_batch,
    MAX_FILES_IN_FLIGHT, MAX_CONCURRENT_BATCHES,
)

# Load .env from the service directory (local dev). In production, the host
# (Render/Railway/etc.) injects env vars directly; dotenv just no-ops.
_HERE = os.path.dirname(os.path.abspath(__file__))
for env_path in (os.path.join(_HERE, ".env"), os.path.join(_HERE, ".env.local")):
    if os.path.exists(env_path):
        dotenv.load_dotenv(env_path, override=False)


# ─── Credentials ────────────────────────────────────────────────────────────
ELEVEN_KEY    = os.getenv("ELEVENLABS_API_KEY")
AZURE_KEY     = os.getenv("AZURE_OPENAI_API_KEY")
AZURE_ENDPT   = os.getenv("AZURE_OPENAI_ENDPOINT")
AZURE_VERSION = os.getenv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview")
AZURE_DEPLOY  = os.getenv("AZURE_DEPLOYMENT", "gpt-4o-mini")

if not (ELEVEN_KEY and AZURE_KEY and AZURE_ENDPT):
    print(
        "WARNING: Missing one or more credentials. Set ELEVENLABS_API_KEY, "
        "AZURE_OPENAI_API_KEY, and AZURE_OPENAI_ENDPOINT in the environment "
        "before requests will succeed.",
        file=sys.stderr,
    )

eleven_client = ElevenLabs(api_key=ELEVEN_KEY) if ELEVEN_KEY else None
llm_client    = AzureOpenAI(
    api_key=AZURE_KEY,
    azure_endpoint=AZURE_ENDPT,
    api_version=AZURE_VERSION,
) if (AZURE_KEY and AZURE_ENDPT) else None


# ─── FastAPI app ────────────────────────────────────────────────────────────
app = FastAPI(
    title="Call Analysis Pipeline API",
    description=(
        "Production API for the Call Analysis Pipeline. "
        "ElevenLabs Scribe v2 STT (code-mixed Indian-language output, with diarization) → "
        "Multi-agent sentiment analysis (5 specialists + 1 synthesizer) on gpt-4o-mini. "
        "Returns granular per-stage and per-token cost tracking with every response."
    ),
    version="1.0.0",
)


# CORS — read allowed origins from env. Defaults are permissive for local dev.
# In production set ALLOWED_ORIGINS="https://your-frontend.vercel.app,https://your-domain.com".
def _parse_origins() -> List[str]:
    raw = os.getenv("ALLOWED_ORIGINS", "").strip()
    if not raw:
        return ["*"]   # permissive default — tighten in production
    return [o.strip() for o in raw.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Pydantic schemas ───────────────────────────────────────────────────────
class PricingResponse(BaseModel):
    rate_card: dict
    notes: List[str]


class AnalyzeResponse(BaseModel):
    success: bool
    result: Optional[dict] = None
    error: Optional[str] = None


# ─── Endpoints ──────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    """Friendly landing page — useful when smoke-testing a deploy."""
    return {
        "service": "call-analysis-pipeline",
        "status": "ok",
        "docs": "/docs",
        "version": app.version,
    }


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "call-analysis-pipeline",
        "vendors": {
            "stt": "ElevenLabs Scribe v2",
            "llm": "Azure OpenAI gpt-4o-mini",
        },
        "credentials_loaded": {
            "elevenlabs": eleven_client is not None,
            "azure_openai": llm_client is not None,
        },
        "concurrency": {
            "files_in_flight": MAX_FILES_IN_FLIGHT,
            "max_concurrent_batches": MAX_CONCURRENT_BATCHES,
        },
        "allowed_origins": _parse_origins(),
        "checked_at_utc": datetime.utcnow().isoformat(),
    }


@app.get("/pricing", response_model=PricingResponse)
async def pricing():
    return {
        "rate_card": RATE_CARD,
        "notes": [
            "ElevenLabs Scribe v2 base: $0.22/hr of audio (async/batch).",
            "Keyterms surcharge: +$0.05/hr when 'keyterms' parameter is used.",
            "Entity-detection surcharge: +$0.07/hr (not enabled by default in this pipeline).",
            "Detect-speaker-roles surcharge: +10% of base (not enabled by default).",
            "Azure gpt-4o-mini: $0.20/M input tokens, $0.60/M output tokens (Standard tier).",
            "No LLM translation step — Scribe v2's code-mixed output is consumed by the multi-agent system directly.",
        ],
    }


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(
    file: UploadFile = File(..., description="Audio file (mp3/wav/m4a/etc.)"),
    keyterms: Optional[str] = Form(
        None,
        description="Optional comma-separated keyterms to bias the STT toward domain vocabulary "
                    "(e.g. 'Bajaj Auto Credit,EMI,OTP,Aadhaar,Pulsar,Avenger'). Up to 1000 terms.",
    ),
):
    """Synchronous single-file analysis. Returns full result inline.
    Latency: ~25-60s depending on call length (5+ min calls may exceed 60s).
    For long calls or multiple files, prefer POST /batch.
    """
    if eleven_client is None or llm_client is None:
        raise HTTPException(
            status_code=503,
            detail="Service missing credentials. Set ELEVENLABS_API_KEY, AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT.",
        )

    keyterm_list: List[str] = []
    if keyterms:
        keyterm_list = [k.strip() for k in keyterms.split(",") if k.strip()]

    suffix = os.path.splitext(file.filename or "")[1] or ".mp3"
    fd, temp_path = tempfile.mkstemp(suffix=suffix)
    try:
        content = await file.read()
        with os.fdopen(fd, "wb") as f:
            f.write(content)

        result = analyze_call_end_to_end(
            audio_path=temp_path,
            eleven_client=eleven_client,
            llm_client=llm_client,
            llm_deployment=AZURE_DEPLOY,
            keyterms=keyterm_list,
        )
        result["filename"] = file.filename or result.get("filename")
        return {"success": True, "result": result}

    except Exception as e:
        return {"success": False, "error": f"{type(e).__name__}: {e}", "result": None}

    finally:
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except Exception:
            pass


# ─── Batch endpoints (async job-based) ──────────────────────────────────────

@app.post("/batch")
async def create_batch_endpoint(
    files: List[UploadFile] = File(..., description="One or more audio files."),
    keyterms: Optional[str] = Form(
        None,
        description="Optional comma-separated keyterms (applies to ALL files in the batch).",
    ),
):
    """Create a new batch analysis job.

    Returns immediately with a job_id. Files process in parallel in the
    background (up to MAX_FILES_IN_FLIGHT concurrent). Poll GET /batch/{job_id}.
    """
    if eleven_client is None or llm_client is None:
        raise HTTPException(
            status_code=503,
            detail="Service missing credentials.",
        )

    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required.")
    if len(files) > 50:
        raise HTTPException(status_code=400, detail="Max 50 files per batch.")

    audio_data: List[tuple] = []
    for uf in files:
        content = await uf.read()
        if not content:
            continue
        audio_data.append((uf.filename or "unnamed.mp3", content))
    if not audio_data:
        raise HTTPException(status_code=400, detail="All uploaded files were empty.")

    keyterm_list: List[str] = []
    if keyterms:
        keyterm_list = [k.strip() for k in keyterms.split(",") if k.strip()]

    job_id = create_batch(
        audio_data=audio_data,
        keyterms=keyterm_list,
        eleven_client=eleven_client,
        llm_client=llm_client,
        deployment=AZURE_DEPLOY,
    )
    return {
        "job_id":     job_id,
        "status":     "queued",
        "file_count": len(audio_data),
        "keyterms":   keyterm_list,
        "concurrency": {
            "files_in_flight": MAX_FILES_IN_FLIGHT,
            "max_concurrent_batches": MAX_CONCURRENT_BATCHES,
        },
    }


@app.get("/batch/{job_id}")
async def get_batch_endpoint(job_id: str):
    """Get full status + per-file progress + per-file results for a batch job."""
    job = get_batch(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Batch job {job_id} not found.")
    return job


@app.get("/batches")
async def list_batches_endpoint(limit: int = 20):
    """List recent batch jobs (summary only — no per-file results)."""
    return {"batches": list_recent_batches(limit=limit)}


@app.delete("/batch/{job_id}")
async def delete_batch_endpoint(job_id: str):
    """Remove a batch job from the in-memory store."""
    if delete_batch(job_id):
        return {"deleted": True, "job_id": job_id}
    raise HTTPException(status_code=404, detail=f"Batch job {job_id} not found.")


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8007"))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"> Starting Call Analysis Pipeline API on {host}:{port}")
    print(f"  Allowed origins: {_parse_origins()}")
    print(f"  Concurrency: {MAX_FILES_IN_FLIGHT} files in flight x {MAX_CONCURRENT_BATCHES} batches")
    uvicorn.run(app, host=host, port=port)
