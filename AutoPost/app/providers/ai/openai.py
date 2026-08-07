"""Provedor OpenAI — chamada direta via httpx (Chat Completions)."""
from typing import Any

import httpx

from app.providers.ai import AIError

API_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_MODEL = "gpt-4o-mini"
TIMEOUT = 120.0


async def generate_text(
    api_key: str, model: str, prompt: str,
    temperature: float | None = None, extra_params: dict[str, Any] | None = None,
) -> str:
    body: dict[str, Any] = {
        "model": model or DEFAULT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
    }
    if temperature is not None:
        body["temperature"] = temperature
    if extra_params:
        body.update(extra_params)

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(API_URL, json=body, headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })
    data = r.json()
    if r.status_code != 200:
        msg = data.get("error", {}).get("message", f"HTTP {r.status_code}")
        raise AIError(f"OpenAI: {msg}")
    try:
        text = data["choices"][0]["message"]["content"].strip()
    except (KeyError, IndexError, AttributeError):
        raise AIError("OpenAI: resposta em formato inesperado")
    if not text:
        raise AIError("OpenAI: resposta vazia")
    return text
