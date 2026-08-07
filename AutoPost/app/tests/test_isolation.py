"""Critério de aceite 1: usuário A não acessa nada do usuário B."""
import pytest

from app.tests.conftest import login, make_user


@pytest.fixture
def two_users(conn, client):
    from app import crypto, db

    a_uid = make_user(conn, "Alice", "alice@ex.com")
    b_uid = make_user(conn, "Bob", "bob@ex.com")
    a_tenant = db.get_user(conn, a_uid)["tenant_id"]
    b_tenant = db.get_user(conn, b_uid)["tenant_id"]

    # Dados do B: conta social, post, mídia, template, config de IA.
    b_account = db.upsert_social_account(
        conn, b_tenant, "facebook", "page-b", "Página do Bob",
        crypto.encrypt("token-secreto-do-bob"), None,
    )
    b_media = db.insert_media(conn, b_tenant, "/tmp/bob.jpg", "image/jpeg", 100)
    b_post = db.create_post(conn, b_tenant, "post secreto do Bob", b_media)
    db.schedule_post(conn, b_tenant, b_post, "2099-01-01 10:00:00", [b_account])
    b_template = db.create_template(conn, b_tenant, "tpl-bob", "conteudo do bob")
    db.upsert_ai_settings(
        conn, b_tenant, "openai", crypto.encrypt("sk-bob-secret-key-123456"),
        "gpt-4o-mini", None, None, None,
    )

    login(client, "alice@ex.com")  # cliente fica autenticado como Alice
    return {
        "a_tenant": a_tenant, "b_tenant": b_tenant,
        "b_account": b_account, "b_post": b_post,
        "b_media": b_media, "b_template": b_template,
    }


def test_listagens_nao_vazam_entre_tenants(client, two_users):
    assert client.get("/posts").json() == []
    assert client.get("/accounts").json() == []
    assert client.get("/media").json() == []
    assert client.get("/templates").json() == []
    assert client.get("/ai/settings").status_code == 404


@pytest.mark.parametrize("path", [
    "/posts/{b_post}",
    "/posts/{b_post}/history",
    "/media/{b_media}",
    "/templates/{b_template}",
])
def test_get_por_id_de_outro_tenant_da_404(client, two_users, path):
    r = client.get(path.format(**two_users))
    assert r.status_code == 404


def test_nao_pode_alterar_post_de_outro_tenant(client, two_users):
    b_post = two_users["b_post"]
    assert client.put(f"/posts/{b_post}", json={"texto": "hackeado"}).status_code == 404
    assert client.post(f"/posts/{b_post}/cancel").status_code == 404
    assert client.delete(f"/posts/{b_post}").status_code == 404
    r = client.post(f"/posts/{b_post}/schedule", json={
        "scheduled_at": "2099-06-01T10:00:00", "account_ids": [two_users["b_account"]],
    })
    assert r.status_code == 404


def test_nao_pode_agendar_no_alvo_de_outro_tenant(client, two_users, conn):
    from app import db

    post_id = db.create_post(conn, two_users["a_tenant"], "post da Alice")
    r = client.post(f"/posts/{post_id}/schedule", json={
        "scheduled_at": "2099-06-01T10:00:00", "account_ids": [two_users["b_account"]],
    })
    assert r.status_code == 404
    assert db.get_post(conn, two_users["a_tenant"], post_id)["status"] == "draft"


def test_nao_pode_usar_midia_de_outro_tenant_em_post(client, two_users):
    r = client.post("/posts", json={"texto": "oi", "media_id": two_users["b_media"]})
    assert r.status_code == 404


def test_nao_pode_mexer_em_conta_de_outro_tenant(client, two_users):
    b_account = two_users["b_account"]
    assert client.delete(f"/accounts/{b_account}").status_code == 404
    assert client.post(f"/accounts/{b_account}/validate").status_code == 404


def test_nao_pode_mexer_em_template_de_outro_tenant(client, two_users):
    b_template = two_users["b_template"]
    r = client.put(f"/templates/{b_template}", json={
        "nome": "x", "conteudo": "y", "ativo": True,
    })
    assert r.status_code == 404
    assert client.delete(f"/templates/{b_template}").status_code == 404


def test_ai_settings_do_b_nao_aparece_para_a(client, two_users, conn):
    from app import crypto, db

    db.upsert_ai_settings(
        conn, two_users["a_tenant"], "openai",
        crypto.encrypt("sk-alice-key-abcdefgh"), "gpt-4o-mini", None, None, None,
    )
    body = client.get("/ai/settings").json()
    assert "bob" not in body["api_key"].lower()
    assert body["api_key"].endswith("efgh")


def test_sem_sessao_tudo_401(env):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as anon:
        for path in ("/posts", "/accounts", "/media", "/templates", "/ai/settings", "/auth/me"):
            assert anon.get(path).status_code == 401, path
