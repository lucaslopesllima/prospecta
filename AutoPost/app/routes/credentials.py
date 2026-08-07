"""Credenciais de app por tenant (client id/secret de cada rede social).

O segredo é cifrado em repouso e NUNCA volta pela API — só a máscara. Não há
herança do ambiente: tenant sem credencial não conecta, e não usa a de ninguém.
"""
import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import crypto, db
from app.deps import get_current_user, get_db
from app.providers import social

router = APIRouter(prefix="/credentials", tags=["credentials"])


class CredentialsIn(BaseModel):
    client_id: str
    # None mantém o segredo atual — permite editar o client_id sem redigitar.
    client_secret: str | None = None
    extra: dict | None = None


def _load_module(group: str):
    if group not in social.GROUPS:
        raise HTTPException(status_code=404, detail=f"rede desconhecida: {group}")
    return social.get_oauth_module(group)


def _out(group: str, row: sqlite3.Row | None) -> dict:
    module = social.get_oauth_module(group)
    base = {
        "group": group,
        "label": module.LABEL,
        "providers": list(social.GROUPS[group]),
        "field_labels": module.FIELD_LABELS,
        "configured": row is not None,
        "client_id": None,
        "client_secret": None,
        "extra": None,
        "updated_at": None,
    }
    if row is None:
        # redirect_uri depende de PUBLIC_BASE_URL; se faltar, a tela mostra o erro.
        try:
            base["redirect_uri"] = module.redirect_uri()
        except social.PublishError as e:
            base["redirect_uri"] = None
            base["redirect_uri_error"] = str(e)
        return base
    base.update({
        "client_id": row["client_id"],
        "client_secret": crypto.mask(crypto.decrypt(row["client_secret"])),
        "extra": json.loads(row["extra"]) if row["extra"] else None,
        "updated_at": row["updated_at"],
    })
    try:
        base["redirect_uri"] = module.redirect_uri()
    except social.PublishError as e:
        base["redirect_uri"] = None
        base["redirect_uri_error"] = str(e)
    return base


@router.get("")
def list_credentials(
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    """Uma entrada por rede, configurada ou não — a tela desenha as abas com isto."""
    rows = {r["provider_group"]: r for r in db.list_social_credentials(conn, user["tenant_id"])}
    return [_out(group, rows.get(group)) for group in social.GROUPS]


@router.get("/{group}")
def get_credentials(
    group: str,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    _load_module(group)
    return _out(group, db.get_social_credentials(conn, user["tenant_id"], group))


@router.put("/{group}")
def put_credentials(
    group: str,
    body: CredentialsIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    _load_module(group)
    client_id = body.client_id.strip()
    if not client_id:
        raise HTTPException(status_code=422, detail="client_id é obrigatório")

    current = db.get_social_credentials(conn, user["tenant_id"], group)
    if body.client_secret:
        secret_enc = crypto.encrypt(body.client_secret.strip())
    elif current is not None:
        secret_enc = current["client_secret"]
    else:
        raise HTTPException(
            status_code=422,
            detail="client_secret é obrigatório na primeira configuração",
        )

    db.upsert_social_credentials(
        conn, user["tenant_id"], group, client_id, secret_enc,
        json.dumps(body.extra) if body.extra else None,
    )
    return _out(group, db.get_social_credentials(conn, user["tenant_id"], group))


@router.delete("/{group}", status_code=204)
def delete_credentials(
    group: str,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    _load_module(group)
    if not db.delete_social_credentials(conn, user["tenant_id"], group):
        raise HTTPException(status_code=404, detail="credencial não configurada")
