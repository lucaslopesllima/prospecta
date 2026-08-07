"""Interface mínima de provedores sociais.

Para adicionar LinkedIn/X/TikTok: criar um arquivo novo neste pacote com uma
classe expondo `publish` e `validate`, e registrá-la em PROVIDERS.
"""
from typing import Protocol


class TokenExpired(Exception):
    """Token expirado ou revogado — vira status visível na conta."""


class PublishError(Exception):
    """Falha de publicação com mensagem legível."""


class SocialProvider(Protocol):
    async def publish(
        self,
        external_id: str,
        access_token: str,
        texto: str,
        media_path: str | None = None,
        media_mime: str | None = None,
        media_url: str | None = None,
    ) -> str:
        """Publica e retorna o id externo do post."""
        ...

    async def validate(self, external_id: str, access_token: str) -> bool:
        """True se o token está válido. Levanta TokenExpired se expirado/revogado."""
        ...


def get_provider(name: str) -> SocialProvider:
    from app.providers.social import meta

    providers: dict[str, SocialProvider] = {
        "facebook": meta.FacebookProvider(),
        "instagram": meta.InstagramProvider(),
    }
    if name not in providers:
        raise PublishError(f"provedor social desconhecido: {name}")
    return providers[name]
