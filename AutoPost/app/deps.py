"""Dependências FastAPI: conexão por request e usuário autenticado.

O tenant NUNCA vem do cliente — é derivado do usuário logado, server-side.
"""
import sqlite3
from typing import Iterator

from fastapi import Cookie, Depends, HTTPException

from app import auth, db


def get_db() -> Iterator[sqlite3.Connection]:
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def get_current_user(
    session: str | None = Cookie(default=None),
    conn: sqlite3.Connection = Depends(get_db),
) -> sqlite3.Row:
    if not session:
        raise HTTPException(status_code=401, detail="não autenticado")
    user_id = auth.read_session_token(session)
    if user_id is None:
        raise HTTPException(status_code=401, detail="sessão inválida ou expirada")
    user = db.get_user(conn, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="usuário não existe")
    return user
