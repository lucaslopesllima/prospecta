"""Provedor Anthropic — chamada direta via httpx (Messages API)."""
from typing import Any

import httpx

from app.providers.ai import AIError

API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-opus-5"
TIMEOUT = 120.0


async def generate_text(
    api_key: str, model: str, prompt: str,
    temperature: float | None = None, extra_params: dict[str, Any] | None = None,
) -> str:
    body: dict[str, Any] = {
        "model": model or DEFAULT_MODEL,
        "max_tokens": 2048,
        "messages": [{"role": "user", "content": prompt}],
    }
    # Modelos Claude recentes (Opus 4.7+) rejeitam temperature com 400 —
    # só enviar quando explicitamente configurado pelo usuário.
    if temperature is not None:
        body["temperature"] = temperature
    if extra_params:
        body.update(extra_params)

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(API_URL, json=body, headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        })
    data = r.json()
    if r.status_code != 200:
        msg = data.get("error", {}).get("message", f"HTTP {r.status_code}")
        raise AIError(f"Anthropic: {msg}")
    if data.get("stop_reason") == "refusal":
        raise AIError("Anthropic: a geração foi recusada pelos classificadores de segurança")
    parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
    text = "".join(parts).strip()
    if not text:
        raise AIError("Anthropic: resposta vazia")
    return text
