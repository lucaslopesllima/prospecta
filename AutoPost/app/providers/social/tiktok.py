"""TikTok Content Posting API (v2).

Fluxo OAuth: authorize -> code -> access_token (+ refresh_token). O token de
acesso do TikTok dura ~24h, então o refresh_token é obrigatório para publicar
depois — diferente da Meta, onde o token de página é longevo.

Limitação da plataforma, não do código: o TikTok **não publica texto puro**.
Todo post exige um vídeo. Um post sem mídia falha com mensagem explícita.

O envio usa PULL_FROM_URL (o TikTok baixa o vídeo da nossa URL pública
assinada) — evita o upload em partes e depende de PUBLIC_BASE_URL. O domínio
precisa estar verificado no painel do TikTok para que o pull seja aceito.
"""
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.providers.social import AppCredentials, PublishError, TokenExpired

API = "https://open.tiktokapis.com/v2"
OAUTH_AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/"
SCOPES = "user.info.basic,video.publish"
TIMEOUT = 60.0

LABEL = "TikTok"
FIELD_LABELS = {"client_id": "Client key", "client_secret": "Client secret"}

# Códigos de erro do TikTok que significam "reautorize" e não "tente de novo".
_AUTH_ERRORS = {
    "access_token_invalid", "access_token_expired", "scope_not_authorized",
    "scope_permission_missed",
}


def redirect_uri() -> str:
    if not settings.public_base_url:
        raise PublishError("PUBLIC_BASE_URL não configurada — necessária para OAuth do TikTok")
    return f"{settings.public_base_url}/accounts/tiktok/callback"


def oauth_url(creds: AppCredentials, state: str) -> str:
    params = {
        "client_key": creds.client_id,
        "redirect_uri": redirect_uri(),
        "state": state,
        "scope": SCOPES,
        "response_type": "code",
    }
    return f"{OAUTH_AUTHORIZE}?{urlencode(params)}"


def _raise_for_error(data: dict) -> None:
    """O TikTok devolve HTTP 200 com o erro no corpo — sempre inspecionar."""
    err = data.get("error")
    # /oauth/token/ devolve o erro na raiz como string; as demais, como objeto.
    if isinstance(err, str):
        if err and err != "ok":
            code, msg = err, data.get("error_description", err)
        else:
            return
    elif isinstance(err, dict):
        code = err.get("code", "")
        msg = err.get("message", "erro desconhecido do TikTok")
        if code in ("", "ok"):
            return
    else:
        return
    if code in _AUTH_ERRORS:
        raise TokenExpired(msg)
    raise PublishError(f"TikTok: {msg}")


async def exchange_code(creds: AppCredentials, code: str) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(
            f"{API}/oauth/token/",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "client_key": creds.client_id,
                "client_secret": creds.client_secret,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri(),
            },
        )
        data = r.json()
        _raise_for_error(data)
        if "access_token" not in data:
            raise PublishError(f"TikTok não devolveu access_token: {data}")
        return {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token"),
            "expires_in": data.get("expires_in"),
        }


async def refresh_access_token(creds: AppCredentials, refresh_token: str) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(
            f"{API}/oauth/token/",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "client_key": creds.client_id,
                "client_secret": creds.client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
        )
        data = r.json()
        _raise_for_error(data)
        return {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token", refresh_token),
            "expires_in": data.get("expires_in"),
        }


async def list_connectable_accounts(creds: AppCredentials, tokens: dict) -> list[dict]:
    """O TikTok conecta um perfil por autorização."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(
            f"{API}/user/info/",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
            params={"fields": "open_id,display_name"},
        )
        data = r.json()
        _raise_for_error(data)
        user = data.get("data", {}).get("user", {})
        if not user.get("open_id"):
            raise PublishError(f"TikTok não devolveu o perfil: {data}")
        return [{
            "provider": "tiktok",
            "external_id": user["open_id"],
            "name": user.get("display_name") or user["open_id"],
            "access_token": tokens["access_token"],
            "refresh_token": tokens.get("refresh_token"),
        }]


class TikTokProvider:
    async def publish(
        self, external_id: str, access_token: str, texto: str,
        media_path: str | None = None, media_mime: str | None = None,
        media_url: str | None = None,
    ) -> str:
        if not media_url or not (media_mime or "").startswith("video/"):
            raise PublishError(
                "TikTok só aceita post com vídeo, baixado de uma URL pública —"
                " anexe um vídeo ao post e configure PUBLIC_BASE_URL"
            )
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
        }
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.post(
                f"{API}/post/publish/video/init/",
                headers=headers,
                json={
                    # title é o texto que aparece na legenda do vídeo.
                    "post_info": {"title": texto[:2200], "privacy_level": "SELF_ONLY"},
                    "source_info": {"source": "PULL_FROM_URL", "video_url": media_url},
                },
            )
            data = r.json()
            _raise_for_error(data)
            publish_id = data.get("data", {}).get("publish_id")
            if not publish_id:
                raise PublishError(f"TikTok não devolveu publish_id: {data}")
            return publish_id

    async def validate(self, external_id: str, access_token: str) -> bool:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.get(
                f"{API}/user/info/",
                headers={"Authorization": f"Bearer {access_token}"},
                params={"fields": "open_id"},
            )
            _raise_for_error(r.json())
            return True
