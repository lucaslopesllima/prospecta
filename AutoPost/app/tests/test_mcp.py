import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from app import auth, crypto, db

PROTOCOL_VERSION = "2026-07-28"
TOKEN_PREFIX = "autopost_mcp_"
META = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
}


def hash_mcp_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make_token(conn, tenant_id: int, scopes: str) -> tuple[str, int]:
    raw = f"{TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
    token_id = db.create_mcp_token(
        conn, tenant_id, "teste", hash_mcp_token(raw), raw[:20], scopes, None
    )
    return raw, token_id


def mcp_request(client, token: str | None, method: str, params: dict):
    headers = {
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "MCP-Method": method,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if method == "tools/call":
        headers["MCP-Name"] = params["name"]
    return client.post(
        "/mcp",
        headers=headers,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": {**params, "_meta": META}},
    )


def call_tool(client, token: str, name: str, arguments: dict):
    return mcp_request(
        client, token, "tools/call", {"name": name, "arguments": arguments}
    )


def test_mcp_exige_token_valido_e_revogacao_imediata(conn, client):
    user_id = db.create_tenant_with_user(
        conn, "Alice", "alice-mcp@ex.com", auth.hash_password("senha12345")
    )
    tenant_id = db.get_user(conn, user_id)["tenant_id"]
    token, token_id = make_token(conn, tenant_id, "read")

    assert mcp_request(client, None, "tools/list", {}).status_code == 401
    assert mcp_request(client, f"{TOKEN_PREFIX}{secrets.token_urlsafe(32)}", "tools/list", {}).status_code == 401
    assert mcp_request(client, token, "tools/list", {}).status_code == 200

    assert db.revoke_mcp_token(conn, tenant_id, token_id)
    assert mcp_request(client, token, "tools/list", {}).status_code == 401


def test_mcp_lista_tools_com_anotacoes_de_seguranca(conn, client):
    user_id = db.create_tenant_with_user(
        conn, "Alice", "alice-tools@ex.com", auth.hash_password("senha12345")
    )
    tenant_id = db.get_user(conn, user_id)["tenant_id"]
    token, _ = make_token(conn, tenant_id, "read,generate,write")

    response = mcp_request(client, token, "tools/list", {})
    assert response.status_code == 200
    tools = {tool["name"]: tool for tool in response.json()["result"]["tools"]}
    assert set(tools) == {
        "autopost_listar_contas",
        "autopost_listar_templates",
        "autopost_listar_posts",
        "autopost_gerar_post",
        "autopost_enviar_midia",
        "autopost_criar_rascunho",
        "autopost_agendar_post",
    }
    assert tools["autopost_listar_posts"]["annotations"]["readOnlyHint"] is True
    assert tools["autopost_agendar_post"]["annotations"]["destructiveHint"] is True


def test_mcp_rate_limit_por_token(conn, client, env, monkeypatch):
    user_id = db.create_tenant_with_user(
        conn, "Alice", "alice-rate@ex.com", auth.hash_password("senha12345")
    )
    tenant_id = db.get_user(conn, user_id)["tenant_id"]
    token, _ = make_token(conn, tenant_id, "read")
    monkeypatch.setattr(env, "mcp_rate_limit_per_minute", 1)

    assert mcp_request(client, token, "tools/list", {}).status_code == 200
    response = mcp_request(client, token, "tools/list", {})
    assert response.status_code == 429
    assert response.headers["retry-after"] == "60"


def test_mcp_isola_tenant_cria_rascunho_e_audita(conn, client):
    alice_id = db.create_tenant_with_user(
        conn, "Alice", "alice-isolation@ex.com", auth.hash_password("senha12345")
    )
    bob_id = db.create_tenant_with_user(
        conn, "Bob", "bob-isolation@ex.com", auth.hash_password("senha12345")
    )
    alice = db.get_user(conn, alice_id)["tenant_id"]
    bob = db.get_user(conn, bob_id)["tenant_id"]
    db.create_post(conn, bob, "segredo do Bob")
    token, token_id = make_token(conn, alice, "read,write")

    listed = call_tool(client, token, "autopost_listar_posts", {})
    assert listed.status_code == 200
    assert listed.json()["result"]["structuredContent"]["result"] == []

    created = call_tool(
        client, token, "autopost_criar_rascunho", {"texto": "rascunho da Alice"}
    )
    assert created.status_code == 200
    result = created.json()["result"]
    assert result["isError"] is False
    post_id = result["structuredContent"]["id"]
    assert db.get_post(conn, alice, post_id)["texto"] == "rascunho da Alice"
    assert db.get_post(conn, bob, post_id) is None

    audit = conn.execute(
        "SELECT tool_name, success FROM mcp_audit_log"
        " WHERE tenant_id = ? AND token_id = ? ORDER BY id",
        (alice, token_id),
    ).fetchall()
    assert [(row["tool_name"], row["success"]) for row in audit] == [
        ("autopost_listar_posts", 1),
        ("autopost_criar_rascunho", 1),
    ]


def test_mcp_agendamento_exige_scope_schedule(conn, client):
    user_id = db.create_tenant_with_user(
        conn, "Alice", "alice-scope@ex.com", auth.hash_password("senha12345")
    )
    tenant_id = db.get_user(conn, user_id)["tenant_id"]
    account_id = db.upsert_social_account(
        conn, tenant_id, "facebook", "page-1", "Pagina", crypto.encrypt("token"), None
    )
    post_id = db.create_post(conn, tenant_id, "nao publicar sem permissao")
    token, token_id = make_token(conn, tenant_id, "read,write")
    future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

    response = call_tool(
        client,
        token,
        "autopost_agendar_post",
        {"post_id": post_id, "scheduled_at": future, "account_ids": [account_id]},
    )
    assert response.status_code == 200
    assert response.json()["result"]["isError"] is True
    assert db.get_post(conn, tenant_id, post_id)["status"] == "draft"
    audit = conn.execute(
        "SELECT success, error FROM mcp_audit_log WHERE token_id = ? ORDER BY id DESC LIMIT 1",
        (token_id,),
    ).fetchone()
    assert audit["success"] == 0
    assert "schedule" in audit["error"]


def test_mcp_gera_texto_sem_salvar_post(conn, client, monkeypatch):
    user_id = db.create_tenant_with_user(
        conn, "Alice", "alice-generate@ex.com", auth.hash_password("senha12345")
    )
    tenant_id = db.get_user(conn, user_id)["tenant_id"]
    db.upsert_ai_settings(
        conn,
        tenant_id,
        "openai",
        crypto.encrypt("sk-teste"),
        "modelo-teste",
        "Tom profissional",
        None,
        None,
    )
    token, _ = make_token(conn, tenant_id, "generate")

    async def fake_generate(provider, api_key, model, prompt, temperature, extra_params):
        assert api_key == "sk-teste"
        assert prompt == "Tom profissional\n\nFale sobre vendas"
        return "Post gerado"

    monkeypatch.setattr("app.mcp_server.ai_providers.generate_text", fake_generate)
    response = call_tool(
        client, token, "autopost_gerar_post", {"prompt": "Fale sobre vendas"}
    )
    assert response.status_code == 200
    assert response.json()["result"]["structuredContent"] == {"texto": "Post gerado"}
    assert db.list_posts(conn, tenant_id) == []
