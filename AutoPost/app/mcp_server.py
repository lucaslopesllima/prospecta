"""Servidor MCP remoto do AutoPost.

Transporte Streamable HTTP, PAT por tenant e ferramentas com escopos separados.
O tenant sempre vem do token validado pelo servidor.
"""
import base64
import binascii
import hashlib
import inspect
import json
import os
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import ToolAnnotations
from pydantic import AnyHttpUrl

from app import crypto, db
from app.config import settings
from app.providers import ai as ai_providers
from app.routes.uploads import ALLOWED, sniff_mime

MCP_SCOPE = "mcp"
VALID_SCOPES = frozenset({"read", "generate", "write", "schedule"})
TOKEN_PREFIX = "autopost_mcp_"

READ_ONLY = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False
)
GENERATES_CONTENT = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True
)
WRITES_DRAFT = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False
)
SCHEDULES_PUBLICATION = ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True
)


def hash_mcp_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def parse_scopes(value: str) -> list[str]:
    return [scope for scope in value.split(",") if scope in VALID_SCOPES]


def _base_url() -> str:
    return settings.public_base_url or "http://localhost:8000"


def _as_http_url(value: str) -> AnyHttpUrl:
    return AnyHttpUrl(value)


class DatabaseTokenVerifier(TokenVerifier):
    """Valida PAT aleatorio contra hash SHA-256 salvo no SQLite."""

    async def verify_token(self, token: str) -> AccessToken | None:
        if not token.startswith(TOKEN_PREFIX) or len(token) < len(TOKEN_PREFIX) + 32:
            return None
        conn = db.connect()
        try:
            row = db.get_active_mcp_token(conn, hash_mcp_token(token))
            if row is None:
                return None
            db.touch_mcp_token(conn, row["id"])
            expires_at = None
            if row["expires_at"]:
                expires_at = int(
                    datetime.strptime(row["expires_at"], "%Y-%m-%d %H:%M:%S")
                    .replace(tzinfo=timezone.utc)
                    .timestamp()
                )
            scopes = [MCP_SCOPE, *parse_scopes(row["scopes"])]
            return AccessToken(
                token=token,
                client_id=f"autopost-token-{row['id']}",
                scopes=scopes,
                expires_at=expires_at,
                resource=f"{_base_url()}/mcp",
                subject=str(row["tenant_id"]),
                claims={
                    "iss": _base_url(),
                    "tenant_id": row["tenant_id"],
                    "token_id": row["id"],
                },
            )
        finally:
            conn.close()


@dataclass(frozen=True)
class MCPIdentity:
    tenant_id: int
    token_id: int
    scopes: frozenset[str]


def _identity() -> MCPIdentity:
    access_token = get_access_token()
    claims = access_token.claims if access_token else None
    if not access_token or not claims:
        raise PermissionError("token MCP ausente ou invalido")
    scopes = frozenset(access_token.scopes)
    try:
        return MCPIdentity(
            tenant_id=int(claims["tenant_id"]),
            token_id=int(claims["token_id"]),
            scopes=scopes,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise PermissionError("identidade MCP invalida") from exc


def _audit(identity: MCPIdentity, tool_name: str, success: bool, error: str | None = None) -> None:
    conn = db.connect()
    try:
        db.add_mcp_audit(
            conn,
            identity.tenant_id,
            identity.token_id,
            tool_name,
            success,
            error[:500] if error else None,
        )
    finally:
        conn.close()


async def _run_tool(
    tool_name: str,
    required_scope: str,
    operation: Callable[[MCPIdentity], Any | Awaitable[Any]],
) -> Any:
    identity = _identity()
    try:
        if required_scope not in identity.scopes:
            raise PermissionError(f"token MCP sem permissao '{required_scope}'")
        result = operation(identity)
        if inspect.isawaitable(result):
            result = await result
    except Exception as exc:
        _audit(identity, tool_name, False, str(exc))
        raise
    _audit(identity, tool_name, True)
    return result


def _security_settings() -> TransportSecuritySettings:
    parsed = urlsplit(_base_url())
    hostname = parsed.hostname or "localhost"
    hosts = {
        hostname,
        f"{hostname}:*",
        parsed.netloc,
        "localhost",
        "localhost:*",
        "127.0.0.1",
        "127.0.0.1:*",
    }
    if settings.disable_scheduler:
        hosts.add("testserver")
    origins = {f"{parsed.scheme}://{parsed.netloc}"} if parsed.scheme and parsed.netloc else set()
    return TransportSecuritySettings(
        allowed_hosts=sorted(host for host in hosts if host),
        allowed_origins=sorted(origins),
    )


mcp = MCPServer(
    name="autopost",
    title="AutoPost",
    description="Geracao, rascunhos e agendamento de posts do AutoPost.",
    instructions=(
        "Use ferramentas de leitura antes de criar conteudo. autopost_gerar_post apenas gera texto; "
        "nao salva nem publica. autopost_criar_rascunho salva, mas nao publica. "
        "autopost_agendar_post causa publicacao futura e exige pedido explicito do usuario, "
        "token com escopo schedule e aprovacao do cliente MCP. Nunca invente IDs de conta ou midia."
    ),
    version="1.1.0",
    token_verifier=DatabaseTokenVerifier(),
    auth=AuthSettings(
        issuer_url=_as_http_url(f"{_base_url()}/"),
        resource_server_url=_as_http_url(f"{_base_url()}/mcp"),
        required_scopes=[MCP_SCOPE],
    ),
)


def _account_out(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "provider": row["provider"],
        "name": row["name"],
        "status": row["status"],
        "token_expires_at": row["token_expires_at"],
    }


def _post_out(row, timezone_name: str, conn=None, tenant_id: int | None = None) -> dict[str, Any]:
    def local(value: str | None) -> str | None:
        if not value:
            return None
        dt = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt.astimezone(ZoneInfo(timezone_name)).isoformat()

    media_ids = [row["media_id"]] if row["media_id"] else []
    if conn is not None and tenant_id is not None:
        media_ids = [m["id"] for m in db.list_post_media(conn, tenant_id, row["id"])]
    return {
        "id": row["id"],
        "texto": row["texto"],
        "media_id": row["media_id"],
        "media_ids": media_ids,
        "status": row["status"],
        "scheduled_at": local(row["scheduled_at"]),
        "published_at": local(row["published_at"]),
        "attempts": row["attempts"],
        "last_error": row["last_error"],
    }


@mcp.tool(
    name="autopost_listar_contas",
    description="Lista contas sociais conectadas do tenant autenticado, sem expor tokens.",
    annotations=READ_ONLY,
)
async def listar_contas() -> list[dict[str, Any]]:
    def operation(identity: MCPIdentity):
        conn = db.connect()
        try:
            return [_account_out(row) for row in db.list_social_accounts(conn, identity.tenant_id)]
        finally:
            conn.close()

    return await _run_tool("autopost_listar_contas", "read", operation)


@mcp.tool(
    name="autopost_listar_templates",
    description="Lista templates de texto do tenant autenticado.",
    annotations=READ_ONLY,
)
async def listar_templates() -> list[dict[str, Any]]:
    def operation(identity: MCPIdentity):
        conn = db.connect()
        try:
            return [
                {
                    "id": row["id"],
                    "nome": row["nome"],
                    "conteudo": row["conteudo"],
                    "ativo": bool(row["ativo"]),
                }
                for row in db.list_templates(conn, identity.tenant_id)
            ]
        finally:
            conn.close()

    return await _run_tool("autopost_listar_templates", "read", operation)


@mcp.tool(
    name="autopost_listar_posts",
    description="Lista posts recentes do tenant, opcionalmente filtrados por status.",
    annotations=READ_ONLY,
)
async def listar_posts(status: str | None = None, limite: int = 20) -> list[dict[str, Any]]:
    def operation(identity: MCPIdentity):
        if status is not None and status not in db.POST_STATUSES:
            raise ValueError(f"status invalido; use um de: {', '.join(db.POST_STATUSES)}")
        if limite < 1 or limite > 100:
            raise ValueError("limite deve ficar entre 1 e 100")
        conn = db.connect()
        try:
            tenant = db.get_tenant(conn, identity.tenant_id)
            rows = db.list_posts(conn, identity.tenant_id, status)[:limite]
            return [
                _post_out(row, tenant["timezone"], conn, identity.tenant_id)
                for row in rows
            ]
        finally:
            conn.close()

    return await _run_tool("autopost_listar_posts", "read", operation)


@mcp.tool(
    name="autopost_gerar_post",
    description=(
        "Gera texto com a IA configurada no AutoPost. Pode combinar um template. "
        "Nao salva rascunho e nao publica."
    ),
    annotations=GENERATES_CONTENT,
)
async def gerar_post(prompt: str | None = None, template_id: int | None = None) -> dict[str, str]:
    async def operation(identity: MCPIdentity):
        if prompt and len(prompt) > settings.mcp_max_prompt_chars:
            raise ValueError(f"prompt excede {settings.mcp_max_prompt_chars} caracteres")
        conn = db.connect()
        try:
            cfg = db.get_ai_settings(conn, identity.tenant_id)
            if cfg is None:
                raise ValueError("IA nao configurada no AutoPost")
            final_prompt = prompt
            if template_id is not None:
                template = db.get_template(conn, identity.tenant_id, template_id)
                if template is None:
                    raise ValueError("template nao encontrado")
                final_prompt = (
                    f"{template['conteudo']}\n\n{final_prompt}"
                    if final_prompt
                    else template["conteudo"]
                )
            if not final_prompt:
                final_prompt = cfg["default_prompt"]
            elif cfg["default_prompt"] and prompt:
                final_prompt = f"{cfg['default_prompt']}\n\n{final_prompt}"
            if not final_prompt:
                raise ValueError("informe prompt/template ou configure default_prompt")
            try:
                texto = await ai_providers.generate_text(
                    cfg["provider"],
                    crypto.decrypt(cfg["api_key"]),
                    cfg["model"],
                    final_prompt,
                    cfg["temperature"],
                    json.loads(cfg["extra_params"]) if cfg["extra_params"] else None,
                )
            except ai_providers.AIError as exc:
                raise ValueError(f"falha ao gerar post: {exc}") from exc
            return {"texto": texto}
        finally:
            conn.close()

    return await _run_tool("autopost_gerar_post", "generate", operation)


@mcp.tool(
    name="autopost_enviar_midia",
    description=(
        "Envia imagem ou video em base64 ao tenant autenticado e retorna o ID. "
        "Para Instagram e carrossel, use JPEG."
    ),
    annotations=WRITES_DRAFT,
)
async def enviar_midia(nome: str, conteudo_base64: str) -> dict[str, Any]:
    def operation(identity: MCPIdentity):
        encoded = conteudo_base64.split(",", 1)[-1]
        try:
            content = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("conteudo_base64 invalido") from exc
        max_bytes = settings.max_upload_mb * 1024 * 1024
        if not content or len(content) > max_bytes:
            raise ValueError(f"arquivo vazio ou maior que {settings.max_upload_mb}MB")
        mime = sniff_mime(content[:16])
        if mime not in ALLOWED:
            raise ValueError("tipo de arquivo nao suportado (jpg/png/gif/webp/mp4)")
        tenant_dir = os.path.join(settings.upload_dir, str(identity.tenant_id))
        os.makedirs(tenant_dir, exist_ok=True)
        path = os.path.join(tenant_dir, f"{uuid.uuid4()}{ALLOWED[mime]}")
        with open(path, "wb") as file:
            file.write(content)
        conn = db.connect()
        try:
            media_id = db.insert_media(
                conn, identity.tenant_id, path, mime, len(content), origem="mcp"
            )
            return {
                "id": media_id,
                "nome": os.path.basename(nome),
                "mime": mime,
                "size_bytes": len(content),
            }
        except Exception:
            if os.path.exists(path):
                os.unlink(path)
            raise
        finally:
            conn.close()

    return await _run_tool("autopost_enviar_midia", "write", operation)


@mcp.tool(
    name="autopost_criar_rascunho",
    description="Salva um rascunho no AutoPost. Nao agenda nem publica.",
    annotations=WRITES_DRAFT,
)
async def criar_rascunho(
    texto: str, media_id: int | None = None, media_ids: list[int] | None = None
) -> dict[str, Any]:
    def operation(identity: MCPIdentity):
        if not texto.strip():
            raise ValueError("texto nao pode ficar vazio")
        if len(texto) > 50000:
            raise ValueError("texto excede 50000 caracteres")
        if media_id is not None and media_ids is not None:
            raise ValueError("use media_id ou media_ids, nao ambos")
        ordered_media = media_ids if media_ids is not None else ([media_id] if media_id else [])
        if len(ordered_media) > 10:
            raise ValueError("carrossel aceita no maximo 10 midias")
        if len(ordered_media) != len(set(ordered_media)):
            raise ValueError("midias duplicadas no carrossel")
        conn = db.connect()
        try:
            for item_id in ordered_media:
                if db.get_media(conn, identity.tenant_id, item_id) is None:
                    raise ValueError(f"midia {item_id} nao encontrada")
            post_id = db.create_post(
                conn, identity.tenant_id, texto, media_ids=ordered_media
            )
            tenant = db.get_tenant(conn, identity.tenant_id)
            return _post_out(
                db.get_post(conn, identity.tenant_id, post_id), tenant["timezone"],
                conn, identity.tenant_id,
            )
        finally:
            conn.close()

    return await _run_tool("autopost_criar_rascunho", "write", operation)


def _scheduled_at_utc(value: str, timezone_name: str) -> str:
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo(timezone_name))
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise ValueError("scheduled_at invalido; use ISO 8601") from exc
    utc = dt.astimezone(timezone.utc)
    if utc <= datetime.now(timezone.utc):
        raise ValueError("scheduled_at deve estar no futuro")
    return utc.strftime("%Y-%m-%d %H:%M:%S")


@mcp.tool(
    name="autopost_agendar_post",
    description=(
        "Agenda rascunho existente para contas conectadas. Causa publicacao futura; "
        "use somente apos confirmacao explicita do usuario."
    ),
    annotations=SCHEDULES_PUBLICATION,
)
async def agendar_post(
    post_id: int, scheduled_at: str, account_ids: list[int],
    placements: list[str] | None = None,
) -> dict[str, Any]:
    def operation(identity: MCPIdentity):
        unique_accounts = list(dict.fromkeys(account_ids))
        if not unique_accounts:
            raise ValueError("informe ao menos uma conta social")
        if len(unique_accounts) > 10:
            raise ValueError("no maximo 10 contas por agendamento")
        unique_placements = list(dict.fromkeys(placements or ["feed"]))
        if not unique_placements or any(p not in ("feed", "story") for p in unique_placements):
            raise ValueError("placements aceita feed e/ou story")
        conn = db.connect()
        try:
            tenant = db.get_tenant(conn, identity.tenant_id)
            post = db.get_post(conn, identity.tenant_id, post_id)
            if post is None:
                raise ValueError("post nao encontrado")
            if "story" in unique_placements and not db.list_post_media(
                conn, identity.tenant_id, post_id
            ):
                raise ValueError("Story exige imagem")
            for account_id in unique_accounts:
                account = db.get_social_account(conn, identity.tenant_id, account_id)
                if account is None:
                    raise ValueError(f"conta {account_id} nao encontrada")
                if account["status"] != "connected":
                    raise ValueError(f"conta {account_id} esta com status {account['status']}")
                if "story" in unique_placements and account["provider"] not in (
                    "facebook", "instagram"
                ):
                    raise ValueError(f"Story nao suportado em {account['provider']}")
            when = _scheduled_at_utc(scheduled_at, tenant["timezone"])
            if not db.schedule_post(
                conn, identity.tenant_id, post_id, when, unique_accounts,
                unique_placements,
            ):
                raise ValueError("post nao encontrado ou nao agendavel")
            return _post_out(
                db.get_post(conn, identity.tenant_id, post_id), tenant["timezone"],
                conn, identity.tenant_id,
            )
        finally:
            conn.close()

    return await _run_tool("autopost_agendar_post", "schedule", operation)


class MCPRateLimitMiddleware:
    """Limite por token valido, antes do protocolo, sem guardar o segredo."""

    def __init__(self, app):
        self.app = app
        self.requests: dict[int, deque[float]] = defaultdict(deque)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and settings.mcp_rate_limit_per_minute > 0:
            headers = {key.lower(): value for key, value in scope.get("headers", [])}
            authorization = headers.get(b"authorization", b"").decode("latin-1")
            if authorization.lower().startswith("bearer "):
                token = authorization[7:]
                conn = db.connect()
                try:
                    row = db.get_active_mcp_token(conn, hash_mcp_token(token))
                finally:
                    conn.close()
                if row is not None:
                    import time

                    now = time.monotonic()
                    bucket = self.requests[row["id"]]
                    while bucket and bucket[0] <= now - 60:
                        bucket.popleft()
                    if len(bucket) >= settings.mcp_rate_limit_per_minute:
                        await send(
                            {
                                "type": "http.response.start",
                                "status": 429,
                                "headers": [
                                    (b"content-type", b"text/plain; charset=utf-8"),
                                    (b"retry-after", b"60"),
                                ],
                            }
                        )
                        await send(
                            {"type": "http.response.body", "body": b"MCP rate limit exceeded"}
                        )
                        return
                    bucket.append(now)
        await self.app(scope, receive, send)


class ReloadableMCPApplication:
    """Mantem mount estavel e recria session manager entre lifespans de teste."""

    def __init__(self) -> None:
        self.rebuild()

    def rebuild(self) -> None:
        protocol_app = mcp.streamable_http_app(
            streamable_http_path="/mcp",
            json_response=True,
            stateless_http=True,
            max_request_body_size=1024 * 1024,
            transport_security=_security_settings(),
        )
        self.app = MCPRateLimitMiddleware(protocol_app)

    async def __call__(self, scope, receive, send):
        await self.app(scope, receive, send)


mcp_http_app = ReloadableMCPApplication()


def prepare_lifespan() -> None:
    """SDK MCP permite um run por manager; recria somente depois que ele foi usado."""
    manager = getattr(mcp, "session_manager", None)
    if manager is not None and getattr(manager, "_has_started", False):
        mcp_http_app.rebuild()
