FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    BG_MODEL=birefnet-general \
    ALPHA_MATTING=1 \
    MAX_CONCURRENCY=2 \
    U2NET_HOME=/app/models \
    NUMBA_CACHE_DIR=/tmp/numba

WORKDIR /app

# System libs needed by onnxruntime / image stacks; curl for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py .

# Pre-download the model weights at build time so the first request is fast
# and the running container needs no outbound network.
RUN python -c "import os; from rembg import new_session; new_session(os.environ['BG_MODEL'])"

# Run as a non-root user.
RUN useradd --create-home appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:7000/health || exit 1

# Single worker: the model is large, so scale with more replicas behind a load
# balancer rather than more workers (each worker loads its own copy).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000", \
     "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
