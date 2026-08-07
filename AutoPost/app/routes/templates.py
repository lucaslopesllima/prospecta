import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import db
from app.deps import get_current_user, get_db

router = APIRouter(prefix="/templates", tags=["templates"])


class TemplateIn(BaseModel):
    nome: str
    conteudo: str
    ativo: bool = True


def _out(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "nome": row["nome"],
        "conteudo": row["conteudo"],
        "ativo": bool(row["ativo"]),
    }


@router.get("")
def list_templates(
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    return [_out(t) for t in db.list_templates(conn, user["tenant_id"])]


@router.post("", status_code=201)
def create_template(
    body: TemplateIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    template_id = db.create_template(conn, user["tenant_id"], body.nome, body.conteudo)
    return _out(db.get_template(conn, user["tenant_id"], template_id))


@router.get("/{template_id}")
def get_template(
    template_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    row = db.get_template(conn, user["tenant_id"], template_id)
    if row is None:
        raise HTTPException(status_code=404, detail="template não encontrado")
    return _out(row)


@router.put("/{template_id}")
def update_template(
    template_id: int,
    body: TemplateIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if not db.update_template(conn, user["tenant_id"], template_id, body.nome, body.conteudo, body.ativo):
        raise HTTPException(status_code=404, detail="template não encontrado")
    return _out(db.get_template(conn, user["tenant_id"], template_id))


@router.delete("/{template_id}", status_code=204)
def delete_template(
    template_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if not db.delete_template(conn, user["tenant_id"], template_id):
        raise HTTPException(status_code=404, detail="template não encontrado")
