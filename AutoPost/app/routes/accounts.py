import logging
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse

from app import auth, crypto, db
from app.deps import get_current_user, get_db
from app.providers import social
from app.providers.social import meta

router = APIRouter(prefix="/accounts", tags=["accounts"])
log = logging.getLogger("autopost")


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


@router.get("/meta/connect")
def meta_connect(user: sqlite3.Row = Depends(get_current_user)):
    if not user:
        raise HTTPException(status_code=401)
    state = auth.sign_oauth_state(user["id"])
    return RedirectResponse(meta.oauth_url(state))


@router.get("/meta/callback")
async def meta_callback(
    code: str,
    state: str,
    conn: sqlite3.Connection = Depends(get_db),
):
    # O tenant vem do state assinado (gerado no /connect por usuário logado).
    user_id = auth.read_oauth_state(state)
    if user_id is None:
        raise HTTPException(status_code=401, detail="state inválido ou expirado")
    user = db.get_user(conn, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="usuário não existe")

    try:
        user_token = await meta.exchange_code_for_long_lived_token(code)
        accounts = await meta.list_connectable_accounts(user_token)
    except (social.PublishError, social.TokenExpired) as e:
        raise HTTPException(status_code=502, detail=f"falha na Meta: {e}")

    saved = []
    for acc in accounts:
        account_id = db.upsert_social_account(
            conn, user["tenant_id"], acc["provider"], acc["external_id"],
            acc["name"], crypto.encrypt(acc["access_token"]), None,
        )
        saved.append({"id": account_id, "provider": acc["provider"], "name": acc["name"]})
    log.info("tenant=%s conectou %d contas Meta", user["tenant_id"], len(saved))
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
