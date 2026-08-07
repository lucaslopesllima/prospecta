"""Fluxo básico da API: auth, posts, uploads, templates, timezone."""
import os

import pytest

from app import crypto, db
from app.tests.conftest import login, make_user

PNG = bytes.fromhex("89504e470d0a1a0a") + b"resto do arquivo"


@pytest.fixture
def alice(conn, client):
    uid = make_user(conn, "Alice", "alice@ex.com")
    login(client, "alice@ex.com")
    return db.get_user(conn, uid)["tenant_id"]


def test_login_invalido(client, conn):
    make_user(conn, "Alice", "alice@ex.com")
    r = client.post("/auth/login", json={"email": "alice@ex.com", "senha": "errada"})
    assert r.status_code == 401
    r = client.post("/auth/login", json={"email": "ninguem@ex.com", "senha": "senha12345"})
    assert r.status_code == 401


def test_me_e_logout(client, alice):
    assert client.get("/auth/me").json()["email"] == "alice@ex.com"
    client.post("/auth/logout")
    assert client.get("/auth/me").status_code == 401


def test_ciclo_de_vida_do_post(client, alice, conn):
    account_id = db.upsert_social_account(
        conn, alice, "facebook", "p1", "Página", crypto.encrypt("tok"), None
    )

    post = client.post("/posts", json={"texto": "rascunho"}).json()
    assert post["status"] == "draft"

    post = client.put(f"/posts/{post['id']}", json={"texto": "editado"}).json()
    assert post["texto"] == "editado"

    r = client.post(f"/posts/{post['id']}/schedule", json={
        "scheduled_at": "2099-06-01T10:00:00", "account_ids": [account_id],
    })
    assert r.status_code == 200
    assert r.json()["status"] == "scheduled"

    detail = client.get(f"/posts/{post['id']}").json()
    assert len(detail["targets"]) == 1
    assert detail["targets"][0]["status"] == "pending"

    assert client.post(f"/posts/{post['id']}/cancel").json()["status"] == "canceled"
    assert client.delete(f"/posts/{post['id']}").status_code == 204
    assert client.get(f"/posts/{post['id']}").status_code == 404


def test_agendar_exige_conta_conectada(client, alice, conn):
    account_id = db.upsert_social_account(
        conn, alice, "facebook", "p1", "Página", crypto.encrypt("tok"), None
    )
    db.set_account_status(conn, alice, account_id, "expired")
    post = client.post("/posts", json={"texto": "x"}).json()
    r = client.post(f"/posts/{post['id']}/schedule", json={
        "scheduled_at": "2099-06-01T10:00:00", "account_ids": [account_id],
    })
    assert r.status_code == 422
    assert "expired" in r.json()["detail"]


def test_agendar_sem_conta_e_invalido(client, alice):
    post = client.post("/posts", json={"texto": "x"}).json()
    r = client.post(f"/posts/{post['id']}/schedule", json={
        "scheduled_at": "2099-06-01T10:00:00", "account_ids": [],
    })
    assert r.status_code == 422


def test_horario_convertido_de_local_para_utc(client, alice, conn):
    account_id = db.upsert_social_account(
        conn, alice, "facebook", "p1", "Página", crypto.encrypt("tok"), None
    )
    post = client.post("/posts", json={"texto": "x"}).json()
    client.post(f"/posts/{post['id']}/schedule", json={
        "scheduled_at": "2099-06-01T10:00:00", "account_ids": [account_id],
    })
    # America/Sao_Paulo (UTC-3) 10:00 local -> 13:00 UTC no banco
    row = db.get_post(conn, alice, post["id"])
    assert row["scheduled_at"] == "2099-06-01 13:00:00"
    # E volta em horário local na API
    assert client.get(f"/posts/{post['id']}").json()["scheduled_at"].startswith("2099-06-01T10:00:00")


def test_data_invalida_da_422(client, alice, conn):
    account_id = db.upsert_social_account(
        conn, alice, "facebook", "p1", "Página", crypto.encrypt("tok"), None
    )
    post = client.post("/posts", json={"texto": "x"}).json()
    r = client.post(f"/posts/{post['id']}/schedule", json={
        "scheduled_at": "amanhã de manhã", "account_ids": [account_id],
    })
    assert r.status_code == 422


def test_upload_valida_mime_real(client, alice):
    r = client.post("/uploads", files={"file": ("a.png", PNG, "image/png")})
    assert r.status_code == 201
    assert r.json()["mime"] == "image/png"

    # Extensão e content-type mentem; o conteúdo não é imagem.
    r = client.post("/uploads", files={"file": ("evil.png", b"<?php echo 1;", "image/png")})
    assert r.status_code == 422


def test_upload_respeita_tamanho_maximo(client, alice, env, monkeypatch):
    monkeypatch.setattr(env, "max_upload_mb", 0)
    r = client.post("/uploads", files={"file": ("a.png", PNG, "image/png")})
    assert r.status_code == 413


def test_media_servida_apenas_por_rota_autenticada(client, alice):
    media_id = client.post("/uploads", files={"file": ("a.png", PNG, "image/png")}).json()["id"]
    assert client.get(f"/media/{media_id}").status_code == 200

    client.post("/auth/logout")
    assert client.get(f"/media/{media_id}").status_code == 401


def test_link_publico_de_midia_exige_token_valido(client, alice):
    from app import auth

    media_id = client.post("/uploads", files={"file": ("a.png", PNG, "image/png")}).json()["id"]
    token = auth.sign_media_token(media_id)
    assert client.get(f"/media/public/{token}").status_code == 200
    assert client.get("/media/public/token-forjado").status_code == 404


def test_crud_de_templates(client, alice):
    tpl = client.post("/templates", json={"nome": "T1", "conteudo": "escreva sobre {tema}"}).json()
    assert tpl["ativo"] is True
    tpl = client.put(f"/templates/{tpl['id']}", json={
        "nome": "T1", "conteudo": "novo", "ativo": False,
    }).json()
    assert tpl["conteudo"] == "novo" and tpl["ativo"] is False
    assert len(client.get("/templates").json()) == 1
    assert client.delete(f"/templates/{tpl['id']}").status_code == 204


def test_ai_settings_mascara_a_chave_e_mantem_ao_atualizar(client, alice):
    r = client.put("/ai/settings", json={
        "provider": "anthropic", "api_key": "sk-ant-super-secreta-abcd",
        "model": "claude-opus-5",
    })
    assert r.status_code == 200
    assert r.json()["api_key"] == "sk-...abcd"
    assert "super-secreta" not in r.text

    # Sem api_key no body, mantém a chave existente.
    r = client.put("/ai/settings", json={"provider": "anthropic", "model": "claude-sonnet-5"})
    assert r.status_code == 200
    assert r.json()["model"] == "claude-sonnet-5"
    assert r.json()["api_key"] == "sk-...abcd"


def test_ai_settings_exige_chave_na_primeira_vez(client, alice):
    r = client.put("/ai/settings", json={"provider": "openai", "model": "gpt-4o-mini"})
    assert r.status_code == 422


def test_ai_generate_sem_config_da_422(client, alice):
    assert client.post("/ai/generate", json={"prompt": "oi"}).status_code == 422


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


def test_frontend_servido(client):
    r = client.get("/")
    assert r.status_code == 200 and "AutoPost" in r.text
    assert client.get("/app/style.css").status_code == 200
    assert client.get("/app/app.js").status_code == 200


def test_uploads_nao_sao_expostos_como_diretorio_estatico(client, alice, conn):
    """Uploads só saem pela rota autenticada — não há montagem estática do diretório."""
    media_id = client.post("/uploads", files={"file": ("a.png", PNG, "image/png")}).json()["id"]
    nome_arquivo = os.path.basename(db.get_media(conn, alice, media_id)["path"])

    assert client.get(f"/uploads/{alice}/{nome_arquivo}").status_code in (404, 405)
    assert client.get(f"/app/{nome_arquivo}").status_code == 404
