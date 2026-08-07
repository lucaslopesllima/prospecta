"""Interface única de provedores de IA: generate_text().

Para adicionar um provedor: criar arquivo novo com `async def generate_text(
api_key, model, prompt, temperature, extra_params) -> str` e registrar aqui.
"""
from typing import Any, Awaitable, Callable


class AIError(Exception):
    """Falha de geração com mensagem legível (nunca contém a API key)."""


GenerateFn = Callable[..., Awaitable[str]]


def get_generator(provider: str) -> GenerateFn:
    from app.providers.ai import anthropic, openai

    providers: dict[str, GenerateFn] = {
        "openai": openai.generate_text,
        "anthropic": anthropic.generate_text,
    }
    if provider not in providers:
        raise AIError(f"provedor de IA desconhecido: {provider}")
    return providers[provider]


async def generate_text(
    provider: str, api_key: str, model: str, prompt: str,
    temperature: float | None = None, extra_params: dict[str, Any] | None = None,
) -> str:
    fn = get_generator(provider)
    return await fn(api_key, model, prompt, temperature, extra_params)
