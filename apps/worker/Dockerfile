# Analysis worker, face-match routes (BE-08a, ADR 0014). Local and staging compose only.
# amd64 only: mediapipe==0.10.21 (pinned) has no Linux arm64 wheel, so Apple-silicon hosts run it emulated.
# Model files are never in the image: mount them read-only at /models (C-22, ADR 0001 section 12).
FROM --platform=linux/amd64 python:3.12-slim

# MediaPipe's OpenCV needs these shared libraries on a slim image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml models.lock.json ./
COPY src ./src
RUN pip install --no-cache-dir '.[face]' uvicorn

RUN useradd --system --no-create-home worker
USER worker

# Strict by default: a deployment must set WORKER_ENV, WORKER_HMAC_KEYS, WORKER_OBJECT_STORE_ORIGINS,
# WORKER_OBJECT_STORE_BUCKET and mount /models. Local compose sets WORKER_ENV=local.
ENV WORKER_ENV=production WORKER_MODELS_DIR=/models WORKER_MODELS_LOCK=/app/models.lock.json
EXPOSE 8000
CMD ["uvicorn", "worker.app:app", "--host", "0.0.0.0", "--port", "8000"]
