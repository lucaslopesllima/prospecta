"""Meta Graph API: Facebook Pages e Instagram Business.

Fluxo OAuth: dialog -> code -> token curto -> token longo -> páginas (cada
página tem seu próprio token, que não expira enquanto o token de usuário for
válido). Contas Instagram Business vinculadas às páginas são detectadas e
salvas como contas separadas (provider='instagram').

As credenciais do app (App ID/Secret) vêm do tenant, não do ambiente — ver
app/routes/credentials.py.
"""
import mimetypes
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.providers.social import AppCredentials, PublishError, TokenExpired

# Cada versão da Graph API vive ~2 anos. v24.0 (out/2025) expira em fev/2028;
# a v21.0 que estava aqui morre em jan/2027. Revise antes disso:
# https://developers.facebook.com/docs/graph-api/changelog/
GRAPH = "https://graph.facebook.com/v24.0"
OAUTH_DIALOG = "https://www.facebook.com/v24.0/dialog/oauth"
# business_management é obrigatória, e a falta dela falha em silêncio: sem ela o
# OAuth conclui normalmente, mas /me/accounts devolve lista vazia — nenhuma
# página para conectar, sem nenhum erro. Só aparece quando a Página pertence a
# um portfólio empresarial, que é o caso normal de página de empresa.
SCOPES = (
    "pages_show_list,pages_read_engagement,pages_manage_posts,"
    "business_management,instagram_basic,instagram_content_publish"
)
TIMEOUT = 30.0

# Rótulos usados pela tela de credenciais.
LABEL = "Meta (Facebook e Instagram)"
FIELD_LABELS = {"client_id": "App ID", "client_secret": "App Secret"}


def redirect_uri() -> str:
    if not settings.public_base_url:
        raise PublishError("PUBLIC_BASE_URL não configurada — necessária para OAuth da Meta")
    return f"{settings.public_base_url}/accounts/meta/callback"


def oauth_url(creds: AppCredentials, state: str) -> str:
    params = {
        "client_id": creds.client_id,
        "redirect_uri": redirect_uri(),
        "state": state,
        "scope": SCOPES,
        "response_type": "code",
    }
    return f"{OAUTH_DIALOG}?{urlencode(params)}"


def _raise_for_graph_error(data: dict) -> None:
    if "error" in data:
        err = data["error"]
        code = err.get("code")
        msg = err.get("message", "erro desconhecido da Graph API")
        if code == 190:
            raise TokenExpired(msg)
        raise PublishError(msg)


async def exchange_code(creds: AppCredentials, code: str) -> dict:
    """code -> token de usuário de longa duração (~60 dias).

    Retorna o formato comum a todos os provedores: access_token, refresh_token
    (a Meta não usa) e expires_in.
    """
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{GRAPH}/oauth/access_token", params={
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "redirect_uri": redirect_uri(),
            "code": code,
        })
        data = r.json()
        _raise_for_graph_error(data)
        short_token = data["access_token"]

        r = await client.get(f"{GRAPH}/oauth/access_token", params={
            "grant_type": "fb_exchange_token",
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "fb_exchange_token": short_token,
        })
        data = r.json()
        _raise_for_graph_error(data)
        return {
            "access_token": data["access_token"],
            "refresh_token": None,
            "expires_in": data.get("expires_in"),
        }


async def list_connectable_accounts(creds: AppCredentials, tokens: dict) -> list[dict]:
    """Páginas do usuário + contas Instagram Business vinculadas.

    Retorna: [{provider, external_id, name, access_token, refresh_token}]
    """
    user_token = tokens["access_token"]
    accounts: list[dict] = []
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{GRAPH}/me/accounts", params={
            "fields": "id,name,access_token,instagram_business_account{id,username}",
            "access_token": user_token,
        })
        data = r.json()
        _raise_for_graph_error(data)
        for page in data.get("data", []):
            accounts.append({
                "provider": "facebook",
                "external_id": page["id"],
                "name": page["name"],
                "access_token": page["access_token"],
                "refresh_token": None,
            })
            ig = page.get("instagram_business_account")
            if ig:
                accounts.append({
                    "provider": "instagram",
                    "external_id": ig["id"],
                    "name": f"@{ig.get('username', ig['id'])}",
                    "access_token": page["access_token"],
                    "refresh_token": None,
                })
    return accounts


class FacebookProvider:
    async def publish(
        self, external_id: str, access_token: str, texto: str,
        media_path: str | None = None, media_mime: str | None = None,
        media_url: str | None = None,
    ) -> str:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            if media_path and media_mime and media_mime.startswith("image/"):
                ext = mimetypes.guess_extension(media_mime) or ".jpg"
                with open(media_path, "rb") as f:
                    r = await client.post(
                        f"{GRAPH}/{external_id}/photos",
                        data={"caption": texto, "access_token": access_token},
                        files={"source": (f"media{ext}", f, media_mime)},
                    )
            else:
                r = await client.post(
                    f"{GRAPH}/{external_id}/feed",
                    data={"message": texto, "access_token": access_token},
                )
            data = r.json()
            _raise_for_graph_error(data)
            return str(data.get("post_id") or data.get("id"))

    async def validate(self, external_id: str, access_token: str) -> bool:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.get(
                f"{GRAPH}/{external_id}",
                params={"fields": "id", "access_token": access_token},
            )
            _raise_for_graph_error(r.json())
            return True


class InstagramProvider:
    async def publish(
        self, external_id: str, access_token: str, texto: str,
        media_path: str | None = None, media_mime: str | None = None,
        media_url: str | None = None,
    ) -> str:
        # O Instagram aceita só JPEG (PNG, MPO e JPS são recusados). Barrar aqui
        # troca um erro obscuro da Graph API por uma mensagem acionável.
        if media_mime and media_mime not in ("image/jpeg", "image/jpg"):
            raise PublishError(
                f"Instagram aceita apenas imagem JPEG — o arquivo enviado é {media_mime}"
            )
        # Limitação da Graph API: o Instagram só aceita mídia por URL pública.
        if not media_url:
            raise PublishError(
                "Instagram exige imagem com URL pública — configure PUBLIC_BASE_URL"
                " e anexe uma imagem ao post"
            )
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(f"{GRAPH}/{external_id}/media", data={
                "image_url": media_url,
                "caption": texto,
                "access_token": access_token,
            })
            data = r.json()
            _raise_for_graph_error(data)
            creation_id = data["id"]

            r = await client.post(f"{GRAPH}/{external_id}/media_publish", data={
                "creation_id": creation_id,
                "access_token": access_token,
            })
            data = r.json()
            _raise_for_graph_error(data)
            return str(data["id"])

    async def validate(self, external_id: str, access_token: str) -> bool:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.get(
                f"{GRAPH}/{external_id}",
                params={"fields": "id", "access_token": access_token},
            )
            _raise_for_graph_error(r.json())
            return True
