"""A worker app with a test key and a signed-request helper (ADR 0014 4.2). Synthetic data only."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI

from worker import signing
from worker.app import create_app
from worker.config import FaceConfig
from worker.modellock import load_lock
from worker.routes_analyze import AudioProvider
from worker.routes_face import FaceRuntime
from worker.vad import VadBackend

KEY = b"k" * 32
LOCK = load_lock(Path(__file__).resolve().parents[1] / "models.lock.json")


def make_app(
    *,
    audio: AudioProvider | None = None,
    vad_backend: Any = None,
    docs_local: bool = False,
    keys: dict[str, bytes] | None = None,
) -> FastAPI:
    runtime = FaceRuntime(
        face_config=FaceConfig.model_validate({}),
        loaded_lock=LOCK,
        check=None,
        fetch=None,
        worker_version="9.9.9",
    )
    backend: Any = vad_backend
    return create_app(
        runtime,
        keys={"k1": KEY} if keys is None else keys,
        docs_local=docs_local,
        audio=audio,
        vad_backend=backend if backend is None or callable(backend) else (lambda: backend),
    )


def sign_headers(
    path: str, body: bytes, *, method: str = "POST", key: bytes = KEY, kid: str = "k1"
) -> tuple[dict[str, str], str]:
    ts = str(int(time.time()))
    nonce = signing._b64url(os.urandom(16))
    sig = signing.sign(key, signing.request_string(kid, method, path, ts, nonce, body))
    return {
        "X-CP-Key-Id": kid,
        "X-CP-Timestamp": ts,
        "X-CP-Nonce": nonce,
        "X-CP-Signature": sig,
        "Content-Type": "application/json",
    }, nonce


def send(
    app: FastAPI,
    path: str,
    payload: Any = None,
    *,
    method: str = "POST",
    signed: bool = True,
    raw: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    body = raw if raw is not None else (b"" if payload is None else json.dumps(payload).encode())
    hdrs: dict[str, str] = dict(headers or {})
    if signed:
        sig_headers, _ = sign_headers(path, body, method=method)
        hdrs = {**sig_headers, **hdrs}

    async def go() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://worker"
        ) as client:
            return await client.request(method, path, headers=hdrs, content=body)

    return asyncio.run(go())


def verify_response(r: httpx.Response, path_nonce_headers: dict[str, str]) -> bool:
    """True when the response signature matches the request nonce (ADR 0014 4.2)."""
    kid = r.headers["x-cp-key-id"]
    expected = signing.sign(
        KEY,
        signing.response_string(kid, path_nonce_headers["X-CP-Nonce"], r.status_code, r.content),
    )
    return r.headers["x-cp-signature"] == expected


def vad_backend_of(backend: VadBackend) -> Any:
    return lambda: backend
