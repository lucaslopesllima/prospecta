import json
import logging
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse

from app import auth, crypto, db
from app.deps import get_current_user, get_db
from app.providers import social

router = APIRouter(prefix="/accounts", tags=["accounts"])
log = logging.getLogger("autopost")


def _tenant_credentials(conn, tenant_id: int, group: str) -> social.AppCredentials:
    """Credenciais do app daquele tenant. Sem herança do ambiente."""
    row = db.get_social_credentials(conn, tenant_id, group)
    if row is None:
        raise social.CredentialsMissing(
            f"credenciais de {group} não configuradas — preencha em Credenciais"
        )
    return social.AppCredentials(
        client_id=row["client_id"],
        client_secret=crypto.decrypt(row["client_secret"]),
        extra=json.loads(row["extra"]) if row["extra"] else {},
    )


def _account_out(row: sqlite3.Row) -> dict:
    # access_token NUNCA sai na resposta.
    return {
        "id": row["id"],
        "provider": row["provider"],
        "external_id": row["external_id"],
        "name": row["name"],
        "status": row["status"],
        "token_expires_at": row["token_expires_at"],
        "last_checked_at": row["last_checked_at"],
    }


@router.get("")
def list_accounts(
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    return [_account_out(a) for a in db.list_social_accounts(conn, user["tenant_id"])]


@router.get("/{group}/connect")
def oauth_connect(
    group: str,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if group not in social.GROUPS:
        raise HTTPException(status_code=404, detail=f"rede desconhecida: {group}")
    try:
        creds = _tenant_credentials(conn, user["tenant_id"], group)
    except social.CredentialsMissing as e:
        raise HTTPException(status_code=409, detail=str(e))
    module = social.get_oauth_module(group)
    # O state carrega o usuário E a rede: o callback precisa saber qual app usar.
    state = auth.sign_oauth_state(user["id"])
    try:
        return RedirectResponse(module.oauth_url(creds, state))
    except social.PublishError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/{group}/callback")
async def oauth_callback(
    group: str,
    code: str,
    state: str,
    conn: sqlite3.Connection = Depends(get_db),
):
    if group not in social.GROUPS:
        raise HTTPException(status_code=404, detail=f"rede desconhecida: {group}")
    # O tenant vem do state assinado (gerado no /connect por usuário logado).
    user_id = auth.read_oauth_state(state)
    if user_id is None:
        raise HTTPException(status_code=401, detail="state inválido ou expirado")
    user = db.get_user(conn, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="usuário não existe")

    module = social.get_oauth_module(group)
    try:
        creds = _tenant_credentials(conn, user["tenant_id"], group)
        tokens = await module.exchange_code(creds, code)
        accounts = await module.list_connectable_accounts(creds, tokens)
    except social.CredentialsMissing as e:
        raise HTTPException(status_code=409, detail=str(e))
    except (social.PublishError, social.TokenExpired) as e:
        raise HTTPException(status_code=502, detail=f"falha em {group}: {e}")

    saved = []
    for acc in accounts:
        refresh = acc.get("refresh_token")
        account_id = db.upsert_social_account(
            conn, user["tenant_id"], acc["provider"], acc["external_id"],
            acc["name"], crypto.encrypt(acc["access_token"]), None,
            crypto.encrypt(refresh) if refresh else None,
        )
        saved.append({"id": account_id, "provider": acc["provider"], "name": acc["name"]})
    log.info("tenant=%s conectou %d contas de %s", user["tenant_id"], len(saved), group)
    return {"contas_conectadas": saved}


@router.post("/{account_id}/validate")
async def validate_account(
    account_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    acc = db.get_social_account(conn, user["tenant_id"], account_id)
    if acc is None:
        raise HTTPException(status_code=404, detail="conta não encontrada")
    provider = social.get_provider(acc["provider"])
    try:
        await provider.validate(acc["external_id"], crypto.decrypt(acc["access_token"]))
        status = "connected"
    except social.TokenExpired:
        status = "expired"
    except Exception:
        status = "error"
    db.set_account_status(conn, user["tenant_id"], account_id, status)
    return {"id": account_id, "status": status}


@router.delete("/{account_id}", status_code=204)
def delete_account(
    account_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    try:
        removed = db.delete_social_account(conn, user["tenant_id"], account_id)
    except sqlite3.IntegrityError:
        raise HTTPException(
            status_code=409,
            detail="conta referenciada por posts agendados/publicados — remova os posts antes",
        )
    if not removed:
        raise HTTPException(status_code=404, detail="conta não encontrada")
