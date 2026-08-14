"""Interface mínima de provedores sociais.

Dois conceitos distintos e fáceis de confundir:

- **Credencial de app** (`AppCredentials`): client id/secret do desenvolvedor na
  plataforma. Vive em `social_credentials`, uma por tenant e por *grupo*. É o
  que identifica o app no OAuth.
- **Conta conectada** (`social_accounts`): o token de UMA página/perfil que o
  usuário autorizou. É o que aparece na tela de contas.

Um grupo pode render vários provedores: autorizar a Meta traz páginas do
Facebook e contas do Instagram Business de uma vez.

Para adicionar uma rede nova: criar um módulo neste pacote expondo
`oauth_url`, `exchange_code`, `list_connectable_accounts`, e uma classe com
`publish`/`validate`; depois registrar em GROUPS e PROVIDERS.
"""
from dataclasses import dataclass
from typing import Protocol


class TokenExpired(Exception):
    """Token expirado ou revogado — vira status visível na conta."""


class PublishError(Exception):
    """Falha de publicação com mensagem legível."""


class CredentialsMissing(Exception):
    """Tenant não configurou o app desta rede na tela de credenciais."""


@dataclass(frozen=True)
class AppCredentials:
    """Credenciais do app do tenant numa plataforma (já decifradas)."""

    client_id: str
    client_secret: str
    extra: dict


@dataclass(frozen=True)
class PublishMedia:
    path: str
    mime: str
    url: str | None = None


# grupo -> provedores que aquele OAuth pode conectar
GROUPS: dict[str, tuple[str, ...]] = {
    "meta": ("facebook", "instagram"),
    "tiktok": ("tiktok",),
    "linkedin": ("linkedin",),
}

# provedor -> grupo (inverso de GROUPS)
GROUP_OF: dict[str, str] = {
    provider: group for group, providers in GROUPS.items() for provider in providers
}


def group_of(provider: str) -> str:
    if provider not in GROUP_OF:
        raise PublishError(f"provedor social desconhecido: {provider}")
    return GROUP_OF[provider]


class SocialProvider(Protocol):
    async def publish(
        self,
        external_id: str,
        access_token: str,
        texto: str,
        media_path: str | None = None,
        media_mime: str | None = None,
        media_url: str | None = None,
        media_items: list[PublishMedia] | None = None,
        placement: str = "feed",
    ) -> str:
        """Publica e retorna o id externo do post."""
        ...

    async def validate(self, external_id: str, access_token: str) -> bool:
        """True se o token está válido. Levanta TokenExpired se expirado/revogado."""
        ...


def get_provider(name: str) -> SocialProvider:
    from app.providers.social import linkedin, meta, tiktok

    providers: dict[str, SocialProvider] = {
        "facebook": meta.FacebookProvider(),
        "instagram": meta.InstagramProvider(),
        "tiktok": tiktok.TikTokProvider(),
        "linkedin": linkedin.LinkedInProvider(),
    }
    if name not in providers:
        raise PublishError(f"provedor social desconhecido: {name}")
    return providers[name]


def get_oauth_module(group: str):
    """Módulo que implementa o OAuth do grupo."""
    from app.providers.social import linkedin, meta, tiktok

    modules = {"meta": meta, "tiktok": tiktok, "linkedin": linkedin}
    if group not in modules:
        raise PublishError(f"grupo social desconhecido: {group}")
    return modules[group]
