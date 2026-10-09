"""ADR 0014 6.1: a 400 on /v1 never echoes input; other routes keep their defaults."""

from __future__ import annotations

import asyncio

import httpx
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

from worker.problem import install_problem_handlers


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")
    count: int


def make() -> FastAPI:
    app = FastAPI()

    @app.post("/v1/x")
    async def v1(body: Body) -> dict[str, int]:
        return {"count": body.count}

    @app.post("/old")
    async def old(body: Body) -> dict[str, int]:
        return {"count": body.count}

    install_problem_handlers(app)
    return app


def post(path: str, payload: dict[str, object]) -> httpx.Response:
    async def go() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=make()), base_url="http://w"
        ) as c:
            return await c.post(path, json=payload)

    return asyncio.run(go())


def test_fr403_v1_validation_error_is_400_with_field_paths_and_no_input_echo() -> None:
    r = post("/v1/x", {"count": "SENTINEL-SECRET", "extra-SENTINEL": 1})
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] == "VALIDATION_FAILED"
    assert "SENTINEL" not in r.text  # not even the caller's own key names
    assert r.json()["fields"] == ["*", "count"]


def test_fr403_nested_caller_chosen_keys_and_404_405_never_echo_and_are_problem_json() -> None:
    r = post("/v1/x", {"count": 1, "nested-SENTINEL": {"deep-SENTINEL": 1}})
    assert r.status_code == 400 and "SENTINEL" not in r.text
    r = post("/v1/nope-SENTINEL", {})
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/problem")
    assert r.json()["code"] == "NOT_FOUND" and "SENTINEL" not in r.text


def test_fr403_non_v1_routes_keep_the_default_422() -> None:
    assert post("/old", {"count": "x"}).status_code == 422


def test_fr403_405_on_v1_keeps_the_allow_header() -> None:
    async def go() -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=make()), base_url="http://w"
        ) as c:
            return await c.get("/v1/x")

    r = asyncio.run(go())
    assert r.status_code == 405 and "POST" in r.headers["allow"]


def test_fr403_a_caller_chosen_key_is_never_echoed_even_when_the_body_is_a_dict_or_a_list() -> None:
    app = FastAPI()

    @app.post("/v1/map")
    async def mapped(body: dict[str, int]) -> dict[str, int]:
        return body

    @app.post("/v1/list")
    async def listed(body: list[int]) -> list[int]:
        return body

    install_problem_handlers(app)

    async def go(path: str, payload: object) -> httpx.Response:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://w"
        ) as c:
            return await c.post(path, json=payload)

    for path, payload in (
        ("/v1/map", {"key-SENTINEL": "not-an-int"}),
        ("/v1/list", ["x", {"k-SENTINEL": 1}]),
    ):
        r = asyncio.run(go(path, payload))
        assert r.status_code == 400 and "SENTINEL" not in r.text
        assert r.json()["fields"] == ["*"]
