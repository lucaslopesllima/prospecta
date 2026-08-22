import logging
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import db
from app.deps import get_current_user, get_db

router = APIRouter(prefix="/posts", tags=["posts"])
log = logging.getLogger("autopost")


class PostIn(BaseModel):
    texto: str
    media_id: int | None = None
    media_ids: list[int] | None = None


class ScheduleIn(BaseModel):
    scheduled_at: str  # ISO local (timezone do tenant) ou com offset
    account_ids: list[int]
    placements: list[str] = Field(default_factory=lambda: ["feed"])


def _to_utc(value: str, tz_name: str) -> str:
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail="scheduled_at inválido (use ISO 8601)")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(tz_name))
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _to_local(value: str | None, tz_name: str) -> str | None:
    if not value:
        return None
    dt = datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    return dt.astimezone(ZoneInfo(tz_name)).isoformat()


def _post_out(row: sqlite3.Row, tz_name: str, conn=None, tenant_id: int | None = None) -> dict:
    media_ids = [row["media_id"]] if row["media_id"] else []
    if conn is not None and tenant_id is not None:
        media_ids = [m["id"] for m in db.list_post_media(conn, tenant_id, row["id"])]
    return {
        "id": row["id"],
        "texto": row["texto"],
        "media_id": row["media_id"],
        "media_ids": media_ids,
        "status": row["status"],
        "scheduled_at": _to_local(row["scheduled_at"], tz_name),
        "published_at": _to_local(row["published_at"], tz_name),
        "attempts": row["attempts"],
        "last_error": row["last_error"],
        "created_at": row["created_at"],
    }


def _tz(conn, user) -> str:
    return db.get_tenant(conn, user["tenant_id"])["timezone"]


def _media_ids(body: PostIn) -> list[int]:
    if body.media_ids is not None and body.media_id is not None:
        raise HTTPException(status_code=422, detail="use media_id ou media_ids, não ambos")
    media_ids = body.media_ids if body.media_ids is not None else (
        [body.media_id] if body.media_id is not None else []
    )
    if len(media_ids) > 10:
        raise HTTPException(status_code=422, detail="carrossel aceita no máximo 10 mídias")
    if len(media_ids) != len(set(media_ids)):
        raise HTTPException(status_code=422, detail="mídias duplicadas no carrossel")
    return media_ids


@router.get("")
def list_posts(
    status: str | None = None,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if status and status not in db.POST_STATUSES:
        raise HTTPException(status_code=422, detail="status inválido")
    tz = _tz(conn, user)
    return [
        _post_out(p, tz, conn, user["tenant_id"])
        for p in db.list_posts(conn, user["tenant_id"], status)
    ]


@router.post("", status_code=201)
def create_post(
    body: PostIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    media_ids = _media_ids(body)
    for media_id in media_ids:
        if db.get_media(conn, user["tenant_id"], media_id) is None:
            raise HTTPException(status_code=404, detail=f"mídia {media_id} não encontrada")
    post_id = db.create_post(conn, user["tenant_id"], body.texto, media_ids=media_ids)
    return _post_out(
        db.get_post(conn, user["tenant_id"], post_id), _tz(conn, user),
        conn, user["tenant_id"],
    )


@router.get("/{post_id}")
def get_post(
    post_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    post = db.get_post(conn, user["tenant_id"], post_id)
    if post is None:
        raise HTTPException(status_code=404, detail="post não encontrado")
    out = _post_out(post, _tz(conn, user), conn, user["tenant_id"])
    out["targets"] = [
        {
            "id": t["id"],
            "social_account_id": t["social_account_id"],
            "placement": t["placement"],
            "status": t["status"],
            "external_post_id": t["external_post_id"],
            "error": t["error"],
        }
        for t in db.list_targets(conn, user["tenant_id"], post_id)
    ]
    return out


@router.put("/{post_id}")
def update_post(
    post_id: int,
    body: PostIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    media_ids = _media_ids(body)
    for media_id in media_ids:
        if db.get_media(conn, user["tenant_id"], media_id) is None:
            raise HTTPException(status_code=404, detail=f"mídia {media_id} não encontrada")
    if not db.update_post_content(
        conn, user["tenant_id"], post_id, body.texto, None, media_ids
    ):
        raise HTTPException(status_code=404, detail="post não encontrado ou não editável")
    return _post_out(
        db.get_post(conn, user["tenant_id"], post_id), _tz(conn, user),
        conn, user["tenant_id"],
    )


@router.post("/{post_id}/schedule")
def schedule_post(
    post_id: int,
    body: ScheduleIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if not body.account_ids:
        raise HTTPException(status_code=422, detail="informe ao menos uma conta social")
    placements = list(dict.fromkeys(body.placements))
    if not placements or any(p not in ("feed", "story") for p in placements):
        raise HTTPException(status_code=422, detail="placements aceita feed e/ou story")
    post = db.get_post(conn, user["tenant_id"], post_id)
    if post is None:
        raise HTTPException(status_code=404, detail="post não encontrado")
    if "story" in placements and not db.list_post_media(conn, user["tenant_id"], post_id):
        raise HTTPException(status_code=422, detail="Story exige imagem")
    for account_id in body.account_ids:
        acc = db.get_social_account(conn, user["tenant_id"], account_id)
        if acc is None:
            raise HTTPException(status_code=404, detail=f"conta {account_id} não encontrada")
        if acc["status"] != "connected":
            raise HTTPException(
                status_code=422, detail=f"conta '{acc['name']}' está com status {acc['status']}"
            )
        if "story" in placements and acc["provider"] not in ("facebook", "instagram"):
            raise HTTPException(
                status_code=422, detail=f"Story não suportado em {acc['provider']}"
            )
    tz = _tz(conn, user)
    scheduled_at_utc = _to_utc(body.scheduled_at, tz)
    if not db.schedule_post(
        conn, user["tenant_id"], post_id, scheduled_at_utc,
        list(dict.fromkeys(body.account_ids)), placements,
    ):
        raise HTTPException(status_code=404, detail="post não encontrado ou não agendável")
    log.info("tenant=%s post=%s agendado para %s UTC", user["tenant_id"], post_id, scheduled_at_utc)
    return _post_out(
        db.get_post(conn, user["tenant_id"], post_id), tz, conn, user["tenant_id"]
    )


@router.post("/{post_id}/cancel")
def cancel_post(
    post_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if not db.cancel_post(conn, user["tenant_id"], post_id):
        raise HTTPException(status_code=404, detail="post não encontrado ou não está agendado")
    return _post_out(db.get_post(conn, user["tenant_id"], post_id), _tz(conn, user))


@router.delete("/{post_id}/schedule", status_code=204)
def delete_schedule(
    post_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if not db.delete_scheduled_post(conn, user["tenant_id"], post_id):
        raise HTTPException(status_code=404, detail="agendamento não encontrado")


@router.delete("/{post_id}", status_code=204)
def delete_post(
    post_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if not db.delete_post(conn, user["tenant_id"], post_id):
        raise HTTPException(status_code=404, detail="post não encontrado ou não removível")


@router.get("/{post_id}/history")
def post_history(
    post_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if db.get_post(conn, user["tenant_id"], post_id) is None:
        raise HTTPException(status_code=404, detail="post não encontrado")
    return [
        {
            "id": h["id"],
            "social_account_id": h["social_account_id"],
            "placement": h["placement"],
            "tentativa": h["tentativa"],
            "status": h["status"],
            "erro": h["erro"],
            "timestamp": h["timestamp"],
        }
        for h in db.list_history(conn, user["tenant_id"], post_id)
    ]
