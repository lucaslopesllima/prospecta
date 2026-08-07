"""Provedores sociais: montagem do OAuth e recusas previsíveis.

Não faz rede. Cobre o que quebra em silêncio: URL de autorização malformada,
erro do TikTok que vem com HTTP 200, e publicação que a plataforma não aceita.
"""
import pytest

from app.providers import social
from app.providers.social import AppCredentials, PublishError, TokenExpired, linkedin, tiktok

CREDS = AppCredentials(client_id="id-do-app", client_secret="segredo", extra={})


def test_grupos_e_inverso():
    assert social.group_of("instagram") == "meta"
    assert social.group_of("tiktok") == "tiktok"
    with pytest.raises(PublishError):
        social.group_of("orkut")


def test_oauth_url_tiktok_usa_client_key(env):
    url = tiktok.oauth_url(CREDS, "estado")
    # O TikTok chama de client_key, não client_id — trocar isso quebra o login.
    assert "client_key=id-do-app" in url
    assert "client_id=" not in url
    assert "segredo" not in url
    assert "state=estado" in url


def test_oauth_url_linkedin(env):
    url = linkedin.oauth_url(CREDS, "estado")
    assert url.startswith("https://www.linkedin.com/oauth/v2/authorization?")
    assert "client_id=id-do-app" in url
    assert "w_member_social" in url
    assert "segredo" not in url


def test_redirect_uri_exige_base_url(env, monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "")
    env.reload()
    for module in (tiktok, linkedin):
        with pytest.raises(PublishError):
            module.redirect_uri()


def test_tiktok_erro_vem_com_http_200():
    """O TikTok responde 200 e põe o erro no corpo — ignorar isso engole falhas."""
    tiktok._raise_for_error({"error": {"code": "ok"}})  # não levanta

    with pytest.raises(TokenExpired):
        tiktok._raise_for_error({"error": {"code": "access_token_expired", "message": "expirou"}})

    with pytest.raises(PublishError):
        tiktok._raise_for_error({"error": {"code": "spam_risk", "message": "bloqueado"}})

    # /oauth/token/ devolve o erro como string na raiz.
    with pytest.raises(PublishError):
        tiktok._raise_for_error({"error": "invalid_grant", "error_description": "code usado"})


@pytest.mark.anyio
async def test_tiktok_recusa_post_sem_video():
    with pytest.raises(PublishError, match="vídeo"):
        await tiktok.TikTokProvider().publish("open-id", "tok", "só texto")

    # Imagem também não serve.
    with pytest.raises(PublishError, match="vídeo"):
        await tiktok.TikTokProvider().publish(
            "open-id", "tok", "texto", media_path="/tmp/x.jpg",
            media_mime="image/jpeg", media_url="https://ex.com/x.jpg",
        )


@pytest.mark.anyio
async def test_linkedin_recusa_video():
    with pytest.raises(PublishError, match="imagem"):
        await linkedin.LinkedInProvider().publish(
            "urn:li:person:abc", "tok", "texto",
            media_path="/tmp/v.mp4", media_mime="video/mp4",
        )


def test_get_provider_cobre_as_quatro_redes():
    for nome in ("facebook", "instagram", "tiktok", "linkedin"):
        provider = social.get_provider(nome)
        assert hasattr(provider, "publish") and hasattr(provider, "validate")
