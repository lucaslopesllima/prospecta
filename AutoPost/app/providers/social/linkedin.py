"""LinkedIn — publicação no feed do próprio membro (Posts API).

Fluxo OAuth: authorization -> code -> access_token. O token dura ~60 dias;
refresh_token só é emitido para apps aprovados no programa de refresh, então
pode vir ausente — nesse caso a reconexão é manual quando expirar.

Texto puro funciona; imagem passa por upload em duas etapas (initializeUpload
-> PUT dos bytes -> post referenciando o URN). Vídeo não é suportado aqui.

`external_id` é o URN do autor (`urn:li:person:{sub}`).
"""
import mimetypes
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.providers.social import AppCredentials, PublishError, PublishMedia, TokenExpired

API = "https://api.linkedin.com"
OAUTH_AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization"
OAUTH_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken"
# openid/profile identificam o membro; w_member_social autoriza publicar.
SCOPES = "openid profile w_member_social"
# A Posts API é versionada por data (YYYYMM); sem este header a chamada é
# recusada, e com uma versão fora de suporte também — o LinkedIn mantém cada
# versão por no mínimo 1 ano e depois a desativa. Revise anualmente:
# https://learn.microsoft.com/en-us/linkedin/marketing/versioning
LINKEDIN_VERSION = "202607"
TIMEOUT = 60.0

LABEL = "LinkedIn"
FIELD_LABELS = {"client_id": "Client ID", "client_secret": "Client Secret"}


def redirect_uri() -> str:
    if not settings.public_base_url:
        raise PublishError("PUBLIC_BASE_URL não configurada — necessária para OAuth do LinkedIn")
    return f"{settings.public_base_url}/accounts/linkedin/callback"


def oauth_url(creds: AppCredentials, state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": creds.client_id,
        "redirect_uri": redirect_uri(),
        "state": state,
        "scope": SCOPES,
    }
    return f"{OAUTH_AUTHORIZE}?{urlencode(params)}"


def _headers(access_token: str) -> dict:
    return {
        "Authorization": f"Bearer {access_token}",
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
    }


def _raise_for_response(r: httpx.Response) -> None:
    if r.status_code < 400:
        return
    try:
        message = r.json().get("message", r.text[:300])
    except Exception:
        message = r.text[:300]
    if r.status_code in (401, 403):
        raise TokenExpired(f"LinkedIn: {message}")
    raise PublishError(f"LinkedIn ({r.status_code}): {message}")


async def exchange_code(creds: AppCredentials, code: str) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post(
            OAUTH_TOKEN,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "redirect_uri": redirect_uri(),
            },
        )
        _raise_for_response(r)
        data = r.json()
        if "access_token" not in data:
            raise PublishError(f"LinkedIn não devolveu access_token: {data}")
        return {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token"),
            "expires_in": data.get("expires_in"),
        }


async def list_connectable_accounts(creds: AppCredentials, tokens: dict) -> list[dict]:
    """O LinkedIn conecta o perfil do próprio membro autenticado."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(
            f"{API}/v2/userinfo",
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        _raise_for_response(r)
        me = r.json()
        sub = me.get("sub")
        if not sub:
            raise PublishError(f"LinkedIn não devolveu o perfil: {me}")
        return [{
            "provider": "linkedin",
            "external_id": f"urn:li:person:{sub}",
            "name": me.get("name") or sub,
            "access_token": tokens["access_token"],
            "refresh_token": tokens.get("refresh_token"),
        }]


async def _upload_image(
    client: httpx.AsyncClient, author_urn: str, access_token: str,
    media_path: str, media_mime: str,
) -> str:
    """initializeUpload -> PUT dos bytes. Retorna o URN da imagem."""
    r = await client.post(
        f"{API}/rest/images?action=initializeUpload",
        headers={**_headers(access_token), "Content-Type": "application/json"},
        json={"initializeUploadRequest": {"owner": author_urn}},
    )
    _raise_for_response(r)
    value = r.json().get("value", {})
    upload_url, image_urn = value.get("uploadUrl"), value.get("image")
    if not upload_url or not image_urn:
        raise PublishError(f"LinkedIn não devolveu a URL de upload: {value}")

    with open(media_path, "rb") as f:
        # PUT com o token no Authorization — é o que a documentação especifica
        # para imagem (o upload de vídeo, ao contrário, recusa o token). O host
        # é de storage e não aceita os demais headers da API.
        up = await client.put(
            upload_url,
            content=f.read(),
            headers={"Authorization": f"Bearer {access_token}",
                     "Content-Type": media_mime or "application/octet-stream"},
        )
    _raise_for_response(up)
    # O ideal seria confirmar status=AVAILABLE antes de publicar (imagem que
    # falha no processamento gera post invisível), mas um token só com
    # w_member_social não pode fazer GET em /rest/images. O 2xx do PUT é a
    # única confirmação disponível com os escopos que temos.
    return image_urn


class LinkedInProvider:
    async def publish(
        self, external_id: str, access_token: str, texto: str,
        media_path: str | None = None, media_mime: str | None = None,
        media_url: str | None = None,
        media_items: list[PublishMedia] | None = None,
        placement: str = "feed",
    ) -> str:
        if placement != "feed":
            raise PublishError("Story não suportado no LinkedIn")
        if media_items:
            if len(media_items) > 1:
                raise PublishError("carrossel não suportado no LinkedIn")
            media_path = media_items[0].path
            media_mime = media_items[0].mime
            media_url = media_items[0].url
        body: dict = {
            "author": external_id,
            "commentary": texto,
            "visibility": "PUBLIC",
            "distribution": {
                "feedDistribution": "MAIN_FEED",
                "targetEntities": [],
                "thirdPartyDistributionChannels": [],
            },
            "lifecycleState": "PUBLISHED",
            "isReshareDisabledByAuthor": False,
        }
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            if media_path and (media_mime or "").startswith("image/"):
                mime = media_mime or mimetypes.guess_type(media_path)[0] or "image/jpeg"
                image_urn = await _upload_image(
                    client, external_id, access_token, media_path, mime
                )
                body["content"] = {"media": {"id": image_urn}}
            elif media_path:
                raise PublishError(
                    "LinkedIn aceita apenas imagem como mídia neste app — remova o"
                    " vídeo ou publique só o texto"
                )

            r = await client.post(
                f"{API}/rest/posts",
                headers={**_headers(access_token), "Content-Type": "application/json"},
                json=body,
            )
            _raise_for_response(r)
            # O id do post volta no header, não no corpo (que vem vazio).
            post_id = r.headers.get("x-restli-id") or r.headers.get("X-RestLi-Id")
            if not post_id:
                raise PublishError("LinkedIn não devolveu o id do post criado")
            return post_id

    async def validate(self, external_id: str, access_token: str) -> bool:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.get(
                f"{API}/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            _raise_for_response(r)
            return True
