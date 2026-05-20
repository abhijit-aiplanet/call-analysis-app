FROM python:3.11-slim

WORKDIR /app

# System deps (ffmpeg useful for any audio processing edge cases; small footprint)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Default port — Render/Railway/Fly etc. will override via PORT env var
ENV PORT=8007
EXPOSE 8007

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Use exec form + shell expansion via sh -c so PORT env is picked up
CMD sh -c "uvicorn api:app --host 0.0.0.0 --port ${PORT}"
