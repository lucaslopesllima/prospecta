"""Credenciais de app por tenant: segredo nunca sai, e nada é herdado."""
import pytest

from app import crypto, db
from app.tests.conftest import login, make_user


@pytest.fixture
def alice(conn, client):
    uid = make_user(conn, "Alice", "alice@ex.com")
    login(client, "alice@ex.com")
    return db.get_user(conn, uid)["tenant_id"]


def test_lista_traz_as_tres_redes_mesmo_sem_configurar(client, alice):
    body = client.get("/credentials").json()
    assert [c["group"] for c in body] == ["meta", "tiktok", "linkedin"]
    assert all(c["configured"] is False for c in body)
    assert all(c["client_secret"] is None for c in body)


def test_salvar_e_ler_mascara(client, alice, conn):
    r = client.put("/credentials/meta", json={
        "client_id": "943832435411292", "client_secret": "segredo-super-secreto",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True
    assert body["client_id"] == "943832435411292"
    # Máscara, nunca o valor.
    assert "segredo-super-secreto" not in body["client_secret"]
    assert body["client_secret"].endswith("reto")

    # Em repouso está cifrado, e decifra no valor original.
    row = db.get_social_credentials(conn, alice, "meta")
    assert row["client_secret"] != "segredo-super-secreto"
    assert crypto.decrypt(row["client_secret"]) == "segredo-super-secreto"


def test_secret_vazio_mantem_o_atual(client, alice, conn):
    client.put("/credentials/meta", json={"client_id": "app1", "client_secret": "s3cr3t-longo"})
    r = client.put("/credentials/meta", json={"client_id": "app2"})
    assert r.status_code == 200
    assert r.json()["client_id"] == "app2"
    row = db.get_social_credentials(conn, alice, "meta")
    assert crypto.decrypt(row["client_secret"]) == "s3cr3t-longo"


def test_primeira_configuracao_exige_secret(client, alice):
    r = client.put("/credentials/tiktok", json={"client_id": "só-o-id"})
    assert r.status_code == 422


def test_rede_desconhecida(client, alice):
    assert client.get("/credentials/orkut").status_code == 404
    assert client.put("/credentials/orkut", json={"client_id": "x", "client_secret": "y"}).status_code == 404


def test_remover(client, alice, conn):
    client.put("/credentials/linkedin", json={"client_id": "li", "client_secret": "segredo-longo"})
    assert client.delete("/credentials/linkedin").status_code == 204
    assert db.get_social_credentials(conn, alice, "linkedin") is None
    # Remover de novo não existe mais.
    assert client.delete("/credentials/linkedin").status_code == 404


def test_conectar_sem_credencial_avisa(client, alice):
    r = client.get("/accounts/meta/connect", follow_redirects=False)
    assert r.status_code == 409
    assert "não configurad" in r.json()["detail"]


def test_conectar_com_credencial_redireciona_pro_app_do_tenant(client, alice):
    client.put("/credentials/meta", json={"client_id": "meu-app-id", "client_secret": "segredo-longo"})
    r = client.get("/accounts/meta/connect", follow_redirects=False)
    assert r.status_code == 307
    destino = r.headers["location"]
    assert destino.startswith("https://www.facebook.com/")
    assert "client_id=meu-app-id" in destino
    # O segredo nunca vai na URL do dialog.
    assert "segredo-longo" not in destino


def test_credenciais_nao_vazam_entre_tenants(client, conn, alice):
    """Bob não enxerga nem herda a credencial de Alice."""
    client.put("/credentials/meta", json={"client_id": "app-da-alice", "client_secret": "segredo-longo"})
    client.post("/auth/logout")

    make_user(conn, "Bob", "bob@ex.com")
    login(client, "bob@ex.com")

    meta = next(c for c in client.get("/credentials").json() if c["group"] == "meta")
    assert meta["configured"] is False
    assert meta["client_id"] is None
    # Sem herança: Bob não consegue conectar usando o app de Alice.
    assert client.get("/accounts/meta/connect", follow_redirects=False).status_code == 409


def test_callback_sem_contas_avisa_em_vez_de_devolver_vazio(client, alice, monkeypatch):
    """OAuth que conclui sem trazer conta precisa falhar visível, não devolver []."""
    from app import auth
    from app.providers.social import meta

    client.put("/credentials/meta", json={"client_id": "app", "client_secret": "segredo-longo"})

    async def _tokens(_creds, _code):
        return {"access_token": "tok", "refresh_token": None, "expires_in": None}

    async def _nenhuma_conta(_creds, _tokens):
        return []

    monkeypatch.setattr(meta, "exchange_code", _tokens)
    monkeypatch.setattr(meta, "list_connectable_accounts", _nenhuma_conta)

    state = auth.sign_oauth_state(1)
    r = client.get(f"/accounts/meta/callback?code=abc&state={state}")
    assert r.status_code == 502
    assert "nenhuma conta" in r.json()["detail"]


def test_scopes_da_meta_incluem_business_management():
    """Sem business_management o /me/accounts volta vazio e nada é conectado."""
    from app.providers.social import meta

    assert "business_management" in meta.SCOPES
