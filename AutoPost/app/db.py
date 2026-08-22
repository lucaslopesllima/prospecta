"""ÚNICO ponto de SQL da aplicação.

Regras:
- Funções de negócio exigem `tenant_id` como primeiro argumento após `conn`.
- Funções prefixadas `sched_` são internas do agendador (varrem todos os
  tenants) e NUNCA podem ser chamadas a partir de rotas HTTP.
- Datas armazenadas em UTC no formato 'YYYY-MM-DD HH:MM:SS' (comparável
  lexicograficamente).
"""
import os
import sqlite3
from datetime import datetime, timezone

from app.config import settings

POST_STATUSES = (
    "draft", "scheduled", "publishing", "published", "failed", "missed", "canceled"
)


def now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def connect(db_path: str | None = None) -> sqlite3.Connection:
    path = db_path or settings.db_path
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    last_login TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS social_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    name TEXT NOT NULL,
    access_token TEXT NOT NULL,
    token_expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'connected',
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, provider, external_id)
);

-- Credenciais do APP em cada plataforma (client id/secret do desenvolvedor),
-- por tenant. Não confundir com social_accounts, que guarda o token de UMA
-- conta/página conectada. Aqui é o que identifica o app no OAuth.
-- provider_group agrupa provedores que compartilham o mesmo app: 'meta' cobre
-- facebook e instagram; 'tiktok' e 'linkedin' são 1:1.
CREATE TABLE IF NOT EXISTS social_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    provider_group TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    extra TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, provider_group)
);

CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    origem TEXT NOT NULL DEFAULT 'upload',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    texto TEXT NOT NULL,
    media_id INTEGER REFERENCES media(id),
    status TEXT NOT NULL DEFAULT 'draft',
    scheduled_at TEXT,
    published_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS post_media (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    media_id INTEGER NOT NULL REFERENCES media(id),
    position INTEGER NOT NULL,
    PRIMARY KEY (post_id, position),
    UNIQUE (post_id, media_id)
);

CREATE TABLE IF NOT EXISTS post_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    social_account_id INTEGER NOT NULL REFERENCES social_accounts(id),
    placement TEXT NOT NULL DEFAULT 'feed',
    status TEXT NOT NULL DEFAULT 'pending',
    external_post_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (post_id, social_account_id, placement)
);

CREATE TABLE IF NOT EXISTS publish_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    social_account_id INTEGER NOT NULL,
    placement TEXT NOT NULL DEFAULT 'feed',
    tentativa INTEGER NOT NULL,
    status TEXT NOT NULL,
    erro TEXT,
    timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL UNIQUE REFERENCES tenants(id),
    provider TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    default_prompt TEXT,
    temperature REAL,
    extra_params TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    nome TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Personal access tokens do MCP. O segredo nunca e armazenado: somente SHA-256.
-- tenant_id vem do token validado, nunca de argumento enviado pelo cliente MCP.
CREATE TABLE IF NOT EXISTS mcp_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_tenant ON mcp_tokens (tenant_id, id);

CREATE TABLE IF NOT EXISTS mcp_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    token_id INTEGER REFERENCES mcp_tokens(id),
    tool_name TEXT NOT NULL,
    success INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tenant_created
    ON mcp_audit_log (tenant_id, created_at);
"""


# Colunas acrescentadas depois da 1ª versão do schema. CREATE TABLE IF NOT
# EXISTS não altera tabela existente, então bancos antigos precisam do ALTER.
MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    # (tabela, coluna, definição)
    ("social_accounts", "refresh_token", "TEXT"),
    ("publish_history", "placement", "TEXT NOT NULL DEFAULT 'feed'"),
)


def _migrate(conn: sqlite3.Connection) -> None:
    for table, column, definition in MIGRATIONS:
        cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if not cols:  # tabela ainda não existe — o executescript acabou de criá-la
            continue
        if column not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    target_cols = {r["name"] for r in conn.execute("PRAGMA table_info(post_targets)")}
    if target_cols and "placement" not in target_cols:
        conn.execute("ALTER TABLE post_targets RENAME TO post_targets_legacy")
        conn.execute(
            "CREATE TABLE post_targets ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " tenant_id INTEGER NOT NULL REFERENCES tenants(id),"
            " post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,"
            " social_account_id INTEGER NOT NULL REFERENCES social_accounts(id),"
            " placement TEXT NOT NULL DEFAULT 'feed',"
            " status TEXT NOT NULL DEFAULT 'pending', external_post_id TEXT, error TEXT,"
            " created_at TEXT NOT NULL, updated_at TEXT NOT NULL,"
            " UNIQUE (post_id, social_account_id, placement))"
        )
        conn.execute(
            "INSERT INTO post_targets"
            " (id, tenant_id, post_id, social_account_id, placement, status,"
            " external_post_id, error, created_at, updated_at)"
            " SELECT id, tenant_id, post_id, social_account_id, 'feed', status,"
            " external_post_id, error, created_at, updated_at FROM post_targets_legacy"
        )
        conn.execute("DROP TABLE post_targets_legacy")


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    _migrate(conn)
    conn.commit()


# ---------------------------------------------------------------- tenants/users

def create_tenant_with_user(
    conn, nome: str, email: str, senha_hash: str, tz: str = "America/Sao_Paulo"
) -> int:
    """1 usuário = 1 tenant, criados juntos. Retorna o user_id."""
    now = now_utc()
    cur = conn.execute(
        "INSERT INTO tenants (nome, timezone, created_at) VALUES (?, ?, ?)",
        (nome, tz, now),
    )
    tenant_id = cur.lastrowid
    cur = conn.execute(
        "INSERT INTO users (tenant_id, nome, email, senha_hash, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (tenant_id, nome, email, senha_hash, now, now),
    )
    conn.commit()
    return cur.lastrowid


def get_user_by_email(conn, email: str):
    return conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()


def get_user(conn, user_id: int):
    return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def list_users(conn):
    return conn.execute(
        "SELECT id, tenant_id, nome, email, last_login FROM users ORDER BY id"
    ).fetchall()


def set_password(conn, email: str, senha_hash: str) -> bool:
    cur = conn.execute(
        "UPDATE users SET senha_hash = ?, updated_at = ? WHERE email = ?",
        (senha_hash, now_utc(), email),
    )
    conn.commit()
    return cur.rowcount == 1


def touch_last_login(conn, user_id: int) -> None:
    conn.execute(
        "UPDATE users SET last_login = ?, updated_at = ? WHERE id = ?",
        (now_utc(), now_utc(), user_id),
    )
    conn.commit()


def get_tenant(conn, tenant_id: int):
    return conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()


# --------------------------------------------------------- social_credentials

def upsert_social_credentials(
    conn, tenant_id: int, provider_group: str, client_id: str,
    client_secret_enc: str, extra: str | None,
) -> None:
    now = now_utc()
    conn.execute(
        """
        INSERT INTO social_credentials
            (tenant_id, provider_group, client_id, client_secret, extra,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, provider_group) DO UPDATE SET
            client_id = excluded.client_id,
            client_secret = excluded.client_secret,
            extra = excluded.extra,
            updated_at = excluded.updated_at
        """,
        (tenant_id, provider_group, client_id, client_secret_enc, extra, now, now),
    )
    conn.commit()


def get_social_credentials(conn, tenant_id: int, provider_group: str):
    return conn.execute(
        "SELECT * FROM social_credentials WHERE tenant_id = ? AND provider_group = ?",
        (tenant_id, provider_group),
    ).fetchone()


def list_social_credentials(conn, tenant_id: int):
    return conn.execute(
        "SELECT * FROM social_credentials WHERE tenant_id = ? ORDER BY provider_group",
        (tenant_id,),
    ).fetchall()


def delete_social_credentials(conn, tenant_id: int, provider_group: str) -> bool:
    cur = conn.execute(
        "DELETE FROM social_credentials WHERE tenant_id = ? AND provider_group = ?",
        (tenant_id, provider_group),
    )
    conn.commit()
    return cur.rowcount == 1


# ------------------------------------------------------------- social_accounts

def upsert_social_account(
    conn, tenant_id: int, provider: str, external_id: str, name: str,
    access_token_enc: str, token_expires_at: str | None,
    refresh_token_enc: str | None = None,
) -> int:
    now = now_utc()
    cur = conn.execute(
        """
        INSERT INTO social_accounts
            (tenant_id, provider, external_id, name, access_token, refresh_token,
             token_expires_at, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
        ON CONFLICT (tenant_id, provider, external_id) DO UPDATE SET
            name = excluded.name,
            access_token = excluded.access_token,
            -- provedor que não devolve refresh_token na reconexão não deve
            -- apagar o que já estava guardado.
            refresh_token = COALESCE(excluded.refresh_token, social_accounts.refresh_token),
            token_expires_at = excluded.token_expires_at,
            status = 'connected',
            updated_at = excluded.updated_at
        """,
        (tenant_id, provider, external_id, name, access_token_enc, refresh_token_enc,
         token_expires_at, now, now),
    )
    conn.commit()
    row = conn.execute(
        "SELECT id FROM social_accounts WHERE tenant_id = ? AND provider = ? AND external_id = ?",
        (tenant_id, provider, external_id),
    ).fetchone()
    return row["id"]


def list_social_accounts(conn, tenant_id: int):
    return conn.execute(
        "SELECT * FROM social_accounts WHERE tenant_id = ? ORDER BY id", (tenant_id,)
    ).fetchall()


def get_social_account(conn, tenant_id: int, account_id: int):
    return conn.execute(
        "SELECT * FROM social_accounts WHERE tenant_id = ? AND id = ?",
        (tenant_id, account_id),
    ).fetchone()


def set_account_status(conn, tenant_id: int, account_id: int, status: str) -> None:
    conn.execute(
        "UPDATE social_accounts SET status = ?, last_checked_at = ?, updated_at = ?"
        " WHERE tenant_id = ? AND id = ?",
        (status, now_utc(), now_utc(), tenant_id, account_id),
    )
    conn.commit()


def delete_social_account(conn, tenant_id: int, account_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM social_accounts WHERE tenant_id = ? AND id = ?",
        (tenant_id, account_id),
    )
    conn.commit()
    return cur.rowcount == 1


# ------------------------------------------------------------------------ media

def insert_media(
    conn, tenant_id: int, path: str, mime: str, size_bytes: int, origem: str = "upload"
) -> int:
    now = now_utc()
    cur = conn.execute(
        "INSERT INTO media (tenant_id, path, mime, size_bytes, origem, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (tenant_id, path, mime, size_bytes, origem, now, now),
    )
    conn.commit()
    return cur.lastrowid


def get_media(conn, tenant_id: int, media_id: int):
    return conn.execute(
        "SELECT * FROM media WHERE tenant_id = ? AND id = ?", (tenant_id, media_id)
    ).fetchone()


def list_media(conn, tenant_id: int):
    return conn.execute(
        "SELECT * FROM media WHERE tenant_id = ? ORDER BY id DESC", (tenant_id,)
    ).fetchall()


def media_in_use(conn, tenant_id: int, media_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM posts WHERE tenant_id = ? AND media_id = ? "
        "UNION SELECT 1 FROM post_media WHERE tenant_id = ? AND media_id = ? LIMIT 1",
        (tenant_id, media_id, tenant_id, media_id),
    ).fetchone() is not None


def delete_media(conn, tenant_id: int, media_id: int) -> str | None:
    row = get_media(conn, tenant_id, media_id)
    if row is None:
        return None
    conn.execute("DELETE FROM media WHERE tenant_id = ? AND id = ?", (tenant_id, media_id))
    conn.commit()
    return row["path"]


# ------------------------------------------------------------------------ posts

def _set_post_media(
    conn, tenant_id: int, post_id: int, media_ids: list[int]
) -> None:
    conn.execute(
        "DELETE FROM post_media WHERE tenant_id = ? AND post_id = ?",
        (tenant_id, post_id),
    )
    for position, media_id in enumerate(media_ids):
        conn.execute(
            "INSERT INTO post_media (post_id, tenant_id, media_id, position)"
            " VALUES (?, ?, ?, ?)",
            (post_id, tenant_id, media_id, position),
        )


def create_post(
    conn, tenant_id: int, texto: str, media_id: int | None = None,
    media_ids: list[int] | None = None,
) -> int:
    ordered_media = media_ids if media_ids is not None else ([media_id] if media_id else [])
    now = now_utc()
    cur = conn.execute(
        "INSERT INTO posts (tenant_id, texto, media_id, status, created_at, updated_at)"
        " VALUES (?, ?, ?, 'draft', ?, ?)",
        (tenant_id, texto, ordered_media[0] if ordered_media else None, now, now),
    )
    _set_post_media(conn, tenant_id, cur.lastrowid, ordered_media)
    conn.commit()
    return cur.lastrowid


def get_post(conn, tenant_id: int, post_id: int):
    return conn.execute(
        "SELECT * FROM posts WHERE tenant_id = ? AND id = ?", (tenant_id, post_id)
    ).fetchone()


def list_posts(conn, tenant_id: int, status: str | None = None):
    if status:
        return conn.execute(
            "SELECT * FROM posts WHERE tenant_id = ? AND status = ? ORDER BY id DESC",
            (tenant_id, status),
        ).fetchall()
    return conn.execute(
        "SELECT * FROM posts WHERE tenant_id = ? ORDER BY id DESC", (tenant_id,)
    ).fetchall()


def update_post_content(
    conn, tenant_id: int, post_id: int, texto: str, media_id: int | None,
    media_ids: list[int] | None = None,
) -> bool:
    ordered_media = media_ids if media_ids is not None else ([media_id] if media_id else [])
    cur = conn.execute(
        "UPDATE posts SET texto = ?, media_id = ?, updated_at = ?"
        " WHERE tenant_id = ? AND id = ? AND status IN ('draft', 'scheduled', 'failed', 'missed', 'canceled')",
        (texto, ordered_media[0] if ordered_media else None, now_utc(), tenant_id, post_id),
    )
    if cur.rowcount == 1:
        _set_post_media(conn, tenant_id, post_id, ordered_media)
    conn.commit()
    return cur.rowcount == 1


def list_post_media(conn, tenant_id: int, post_id: int):
    rows = conn.execute(
        "SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media_id"
        " WHERE pm.tenant_id = ? AND pm.post_id = ? ORDER BY pm.position",
        (tenant_id, post_id),
    ).fetchall()
    if rows:
        return rows
    post = get_post(conn, tenant_id, post_id)
    if post is not None and post["media_id"]:
        legacy = get_media(conn, tenant_id, post["media_id"])
        return [legacy] if legacy is not None else []
    return []


def schedule_post(
    conn, tenant_id: int, post_id: int, scheduled_at_utc: str, account_ids: list[int],
    placements: list[str] | None = None,
) -> bool:
    """Agenda (ou reagenda) um post e substitui os alvos."""
    cur = conn.execute(
        "UPDATE posts SET status = 'scheduled', scheduled_at = ?, attempts = 0,"
        " last_error = NULL, updated_at = ?"
        " WHERE tenant_id = ? AND id = ?"
        " AND status IN ('draft', 'scheduled', 'failed', 'missed', 'canceled')",
        (scheduled_at_utc, now_utc(), tenant_id, post_id),
    )
    if cur.rowcount != 1:
        conn.rollback()
        return False
    conn.execute(
        "DELETE FROM post_targets WHERE tenant_id = ? AND post_id = ?",
        (tenant_id, post_id),
    )
    now = now_utc()
    for account_id in account_ids:
        for placement in placements or ["feed"]:
            conn.execute(
                "INSERT INTO post_targets"
                " (tenant_id, post_id, social_account_id, placement, status, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, 'pending', ?, ?)",
                (tenant_id, post_id, account_id, placement, now, now),
            )
    conn.commit()
    return True


def cancel_post(conn, tenant_id: int, post_id: int) -> bool:
    cur = conn.execute(
        "UPDATE posts SET status = 'canceled', updated_at = ?"
        " WHERE tenant_id = ? AND id = ? AND status = 'scheduled'",
        (now_utc(), tenant_id, post_id),
    )
    conn.commit()
    return cur.rowcount == 1


def delete_schedule(conn, tenant_id: int, post_id: int) -> bool:
    cur = conn.execute(
        "UPDATE posts SET status = 'draft', scheduled_at = NULL, attempts = 0, last_error = NULL, updated_at = ?"
        " WHERE tenant_id = ? AND id = ? AND status = 'scheduled'",
        (now_utc(), tenant_id, post_id),
    )
    if cur.rowcount:
        conn.execute("DELETE FROM post_targets WHERE tenant_id = ? AND post_id = ?", (tenant_id, post_id))
    conn.commit()
    return cur.rowcount == 1


def delete_post(conn, tenant_id: int, post_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM posts WHERE tenant_id = ? AND id = ?"
        " AND status IN ('draft', 'canceled', 'failed', 'missed')",
        (tenant_id, post_id),
    )
    conn.commit()
    return cur.rowcount == 1


def list_targets(conn, tenant_id: int, post_id: int):
    return conn.execute(
        "SELECT * FROM post_targets WHERE tenant_id = ? AND post_id = ? ORDER BY id",
        (tenant_id, post_id),
    ).fetchall()


# --------------------------------------------------------------------- history

def add_history(
    conn, tenant_id: int, post_id: int, social_account_id: int,
    tentativa: int, status: str, erro: str | None, placement: str = "feed",
) -> None:
    conn.execute(
        "INSERT INTO publish_history"
        " (tenant_id, post_id, social_account_id, placement, tentativa, status, erro, timestamp)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (tenant_id, post_id, social_account_id, placement, tentativa, status, erro, now_utc()),
    )
    conn.commit()


def list_history(conn, tenant_id: int, post_id: int):
    return conn.execute(
        "SELECT * FROM publish_history WHERE tenant_id = ? AND post_id = ? ORDER BY id",
        (tenant_id, post_id),
    ).fetchall()


# ------------------------------------------------------------------ ai_settings

def upsert_ai_settings(
    conn, tenant_id: int, provider: str, api_key_enc: str, model: str,
    default_prompt: str | None, temperature: float | None, extra_params: str | None,
) -> None:
    now = now_utc()
    conn.execute(
        """
        INSERT INTO ai_settings
            (tenant_id, provider, api_key, model, default_prompt, temperature,
             extra_params, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id) DO UPDATE SET
            provider = excluded.provider,
            api_key = excluded.api_key,
            model = excluded.model,
            default_prompt = excluded.default_prompt,
            temperature = excluded.temperature,
            extra_params = excluded.extra_params,
            updated_at = excluded.updated_at
        """,
        (tenant_id, provider, api_key_enc, model, default_prompt, temperature,
         extra_params, now, now),
    )
    conn.commit()


def get_ai_settings(conn, tenant_id: int):
    return conn.execute(
        "SELECT * FROM ai_settings WHERE tenant_id = ?", (tenant_id,)
    ).fetchone()


# -------------------------------------------------------------------- templates

def create_template(conn, tenant_id: int, nome: str, conteudo: str) -> int:
    now = now_utc()
    cur = conn.execute(
        "INSERT INTO templates (tenant_id, nome, conteudo, created_at, updated_at)"
        " VALUES (?, ?, ?, ?, ?)",
        (tenant_id, nome, conteudo, now, now),
    )
    conn.commit()
    return cur.lastrowid


def list_templates(conn, tenant_id: int):
    return conn.execute(
        "SELECT * FROM templates WHERE tenant_id = ? ORDER BY id", (tenant_id,)
    ).fetchall()


def get_template(conn, tenant_id: int, template_id: int):
    return conn.execute(
        "SELECT * FROM templates WHERE tenant_id = ? AND id = ?",
        (tenant_id, template_id),
    ).fetchone()


def update_template(
    conn, tenant_id: int, template_id: int, nome: str, conteudo: str, ativo: bool
) -> bool:
    cur = conn.execute(
        "UPDATE templates SET nome = ?, conteudo = ?, ativo = ?, updated_at = ?"
        " WHERE tenant_id = ? AND id = ?",
        (nome, conteudo, 1 if ativo else 0, now_utc(), tenant_id, template_id),
    )
    conn.commit()
    return cur.rowcount == 1


def delete_template(conn, tenant_id: int, template_id: int) -> bool:
    cur = conn.execute(
        "DELETE FROM templates WHERE tenant_id = ? AND id = ?",
        (tenant_id, template_id),
    )
    conn.commit()
    return cur.rowcount == 1


# -------------------------------------------------------------------------- MCP

def create_mcp_token(
    conn, tenant_id: int, name: str, token_hash: str, token_prefix: str,
    scopes: str, expires_at: str | None,
) -> int:
    cur = conn.execute(
        "INSERT INTO mcp_tokens"
        " (tenant_id, name, token_hash, token_prefix, scopes, expires_at, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (tenant_id, name, token_hash, token_prefix, scopes, expires_at, now_utc()),
    )
    conn.commit()
    return cur.lastrowid


def get_active_mcp_token(conn, token_hash: str, now: str | None = None):
    return conn.execute(
        "SELECT * FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL"
        " AND (expires_at IS NULL OR expires_at > ?)",
        (token_hash, now or now_utc()),
    ).fetchone()


def touch_mcp_token(conn, token_id: int) -> None:
    conn.execute(
        "UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?",
        (now_utc(), token_id),
    )
    conn.commit()


def list_mcp_tokens(conn, tenant_id: int):
    return conn.execute(
        "SELECT id, name, token_prefix, scopes, expires_at, last_used_at,"
        " revoked_at, created_at FROM mcp_tokens WHERE tenant_id = ? ORDER BY id DESC",
        (tenant_id,),
    ).fetchall()


def revoke_mcp_token(conn, tenant_id: int, token_id: int) -> bool:
    cur = conn.execute(
        "UPDATE mcp_tokens SET revoked_at = ?"
        " WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
        (now_utc(), tenant_id, token_id),
    )
    conn.commit()
    return cur.rowcount == 1


def update_mcp_token(conn, tenant_id: int, token_id: int, name: str, scopes: str, expires_at: str | None) -> bool:
    cur = conn.execute(
        "UPDATE mcp_tokens SET name = ?, scopes = ?, expires_at = ?"
        " WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
        (name, scopes, expires_at, tenant_id, token_id),
    )
    conn.commit()
    return cur.rowcount == 1


def add_mcp_audit(
    conn, tenant_id: int, token_id: int, tool_name: str,
    success: bool, error: str | None = None,
) -> None:
    conn.execute(
        "INSERT INTO mcp_audit_log"
        " (tenant_id, token_id, tool_name, success, error, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (tenant_id, token_id, tool_name, 1 if success else 0, error, now_utc()),
    )
    conn.commit()


# =================================================================== SCHEDULER
# Funções internas do agendador — varrem todos os tenants. Uso exclusivo de
# app/scheduler.py e do catch-up de inicialização. Nunca expor em rotas.

def sched_due_posts(conn, now: str, limit: int = 50):
    return conn.execute(
        "SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?"
        " ORDER BY scheduled_at LIMIT ?",
        (now, limit),
    ).fetchall()


def sched_claim(conn, post_id: int) -> bool:
    """Claim atômico: só publica quem transicionar scheduled -> publishing."""
    cur = conn.execute(
        "UPDATE posts SET status = 'publishing', updated_at = ?"
        " WHERE id = ? AND status = 'scheduled'",
        (now_utc(), post_id),
    )
    conn.commit()
    return cur.rowcount == 1


def sched_pending_targets(conn, post_id: int):
    return conn.execute(
        "SELECT * FROM post_targets WHERE post_id = ? AND status != 'published' ORDER BY id",
        (post_id,),
    ).fetchall()


def sched_get_account(conn, account_id: int):
    return conn.execute(
        "SELECT * FROM social_accounts WHERE id = ?", (account_id,)
    ).fetchone()


def sched_get_media(conn, media_id: int):
    return conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()


def sched_get_post_media(conn, post_id: int):
    rows = conn.execute(
        "SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media_id"
        " WHERE pm.post_id = ? ORDER BY pm.position", (post_id,)
    ).fetchall()
    if rows:
        return rows
    post = conn.execute("SELECT media_id FROM posts WHERE id = ?", (post_id,)).fetchone()
    if post is not None and post["media_id"]:
        media = sched_get_media(conn, post["media_id"])
        return [media] if media is not None else []
    return []


def sched_finish_target(
    conn, target_id: int, status: str, external_post_id: str | None, error: str | None
) -> None:
    conn.execute(
        "UPDATE post_targets SET status = ?, external_post_id = ?, error = ?, updated_at = ?"
        " WHERE id = ?",
        (status, external_post_id, error, now_utc(), target_id),
    )
    conn.commit()


def sched_reset_failed_targets(conn, post_id: int) -> None:
    conn.execute(
        "UPDATE post_targets SET status = 'pending', updated_at = ?"
        " WHERE post_id = ? AND status = 'failed'",
        (now_utc(), post_id),
    )
    conn.commit()


def sched_post_published(conn, post_id: int) -> None:
    conn.execute(
        "UPDATE posts SET status = 'published', published_at = ?, last_error = NULL,"
        " updated_at = ? WHERE id = ?",
        (now_utc(), now_utc(), post_id),
    )
    conn.commit()


def sched_post_retry(conn, post_id: int, attempts: int, next_at: str, error: str) -> None:
    conn.execute(
        "UPDATE posts SET status = 'scheduled', attempts = ?, scheduled_at = ?,"
        " last_error = ?, updated_at = ? WHERE id = ?",
        (attempts, next_at, error, now_utc(), post_id),
    )
    conn.commit()


def sched_post_failed(conn, post_id: int, attempts: int, error: str) -> None:
    conn.execute(
        "UPDATE posts SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?"
        " WHERE id = ?",
        (attempts, error, now_utc(), post_id),
    )
    conn.commit()


def sched_mark_missed(conn, cutoff: str) -> int:
    """Posts vencidos antes da janela de catch-up viram 'missed'."""
    cur = conn.execute(
        "UPDATE posts SET status = 'missed',"
        " last_error = 'app estava desligado no horário agendado (fora da janela de catch-up)',"
        " updated_at = ?"
        " WHERE status = 'scheduled' AND scheduled_at < ?",
        (now_utc(), cutoff),
    )
    conn.commit()
    return cur.rowcount


def sched_recover_publishing(conn) -> None:
    """Posts presos em 'publishing' após restart.

    Alvos já publicados (com external_post_id) são preservados; o filtro de
    alvos pendentes garante que não haja republicação duplicada.
    """
    rows = conn.execute("SELECT id FROM posts WHERE status = 'publishing'").fetchall()
    for row in rows:
        pending = sched_pending_targets(conn, row["id"])
        if pending:
            conn.execute(
                "UPDATE posts SET status = 'scheduled', updated_at = ? WHERE id = ?",
                (now_utc(), row["id"]),
            )
        else:
            conn.execute(
                "UPDATE posts SET status = 'published', published_at = COALESCE(published_at, ?),"
                " updated_at = ? WHERE id = ?",
                (now_utc(), now_utc(), row["id"]),
            )
    conn.commit()


def sched_all_accounts(conn):
    return conn.execute(
        "SELECT * FROM social_accounts WHERE status != 'revoked' ORDER BY id"
    ).fetchall()
