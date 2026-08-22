"""Gestão dos tokens pessoais usados pelo servidor MCP."""
import hashlib
import secrets
import sqlite3
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app import db
from app.deps import get_current_user, get_db
from app.mcp_server import TOKEN_PREFIX, VALID_SCOPES

router = APIRouter(prefix="/mcp-tokens", tags=["mcp"])


class McpTokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    scopes: list[str] = Field(min_length=1)
    expires_at: str | None = None


def _expiry(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        if parsed <= datetime.now(timezone.utc):
            raise ValueError
    except ValueError:
        raise HTTPException(status_code=422, detail="expiração inválida ou no passado")
    return parsed.astimezone(timezone.utc).isoformat()


def _scopes(values: list[str]) -> str:
    unique = list(dict.fromkeys(values))
    if not unique or any(scope not in VALID_SCOPES for scope in unique):
        raise HTTPException(status_code=422, detail="permissões MCP inválidas")
    return ",".join(unique)


def _out(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"], "name": row["name"], "token_prefix": row["token_prefix"],
        "scopes": row["scopes"].split(","), "expires_at": row["expires_at"],
        "last_used_at": row["last_used_at"], "revoked_at": row["revoked_at"], "created_at": row["created_at"],
    }


@router.get("")
def list_tokens(user: sqlite3.Row = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    return [_out(row) for row in db.list_mcp_tokens(conn, user["tenant_id"])]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_token(body: McpTokenIn, user: sqlite3.Row = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="nome do token obrigatório")
    raw = f"{TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
    token_id = db.create_mcp_token(
        conn, user["tenant_id"], body.name.strip(), hashlib.sha256(raw.encode()).hexdigest(),
        raw[:20], _scopes(body.scopes), _expiry(body.expires_at),
    )
    row = next(row for row in db.list_mcp_tokens(conn, user["tenant_id"]) if row["id"] == token_id)
    return {"token": raw, "mcp_token": _out(row)}


@router.put("/{token_id}")
def update_token(token_id: int, body: McpTokenIn, user: sqlite3.Row = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="nome do token obrigatório")
    if not db.update_mcp_token(conn, user["tenant_id"], token_id, body.name.strip(), _scopes(body.scopes), _expiry(body.expires_at)):
        raise HTTPException(status_code=404, detail="token não encontrado ou revogado")
    row = next(row for row in db.list_mcp_tokens(conn, user["tenant_id"]) if row["id"] == token_id)
    return _out(row)


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(token_id: int, user: sqlite3.Row = Depends(get_current_user), conn: sqlite3.Connection = Depends(get_db)):
    if not db.revoke_mcp_token(conn, user["tenant_id"], token_id):
        raise HTTPException(status_code=404, detail="token não encontrado ou já revogado")
