import os
import sqlite3
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app import auth, db
from app.config import settings
from app.deps import get_current_user, get_db

router = APIRouter(tags=["media"])

# Validação por assinatura real do arquivo (magic bytes) — não confiar no
# content-type declarado pelo cliente.
ALLOWED = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
}


def sniff_mime(header: bytes) -> str | None:
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    if header[4:8] == b"ftyp":
        return "video/mp4"
    return None


def _media_out(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "mime": row["mime"],
        "size_bytes": row["size_bytes"],
        "origem": row["origem"],
        "created_at": row["created_at"],
    }


@router.post("/uploads", status_code=201)
async def upload(
    file: UploadFile,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    max_bytes = settings.max_upload_mb * 1024 * 1024
    content = await file.read()
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail=f"arquivo maior que {settings.max_upload_mb}MB")
    mime = sniff_mime(content[:16])
    if mime not in ALLOWED:
        raise HTTPException(status_code=422, detail="tipo de arquivo não suportado (jpg/png/gif/webp/mp4)")

    tenant_dir = os.path.join(settings.upload_dir, str(user["tenant_id"]))
    os.makedirs(tenant_dir, exist_ok=True)
    path = os.path.join(tenant_dir, f"{uuid.uuid4()}{ALLOWED[mime]}")
    with open(path, "wb") as f:
        f.write(content)

    media_id = db.insert_media(conn, user["tenant_id"], path, mime, len(content))
    return _media_out(db.get_media(conn, user["tenant_id"], media_id))


@router.get("/media")
def list_media(
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    return [_media_out(m) for m in db.list_media(conn, user["tenant_id"])]


@router.get("/media/{media_id}")
def get_media_file(
    media_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    # Servido apenas por rota autenticada com checagem de tenant.
    row = db.get_media(conn, user["tenant_id"], media_id)
    if row is None or not os.path.exists(row["path"]):
        raise HTTPException(status_code=404, detail="mídia não encontrada")
    return FileResponse(row["path"], media_type=row["mime"])


@router.delete("/media/{media_id}", status_code=204)
def delete_media_file(
    media_id: int,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    row = db.get_media(conn, user["tenant_id"], media_id)
    if row is None:
        raise HTTPException(status_code=404, detail="mídia não encontrada")
    if db.media_in_use(conn, user["tenant_id"], media_id):
        raise HTTPException(status_code=409, detail="mídia vinculada a um post; remova-a do post antes")
    path = db.delete_media(conn, user["tenant_id"], media_id)
    if path and os.path.exists(path):
        os.remove(path)


@router.get("/media/public/{token}")
def get_public_media(token: str, conn: sqlite3.Connection = Depends(get_db)):
    """Link assinado e temporário (1h) — usado só para publicação no Instagram,
    que exige URL pública. O token é gerado internamente pelo agendador."""
    media_id = auth.read_media_token(token)
    if media_id is None:
        raise HTTPException(status_code=404, detail="link inválido ou expirado")
    row = conn.execute("SELECT * FROM media WHERE id = ?", (media_id,)).fetchone()
    if row is None or not os.path.exists(row["path"]):
        raise HTTPException(status_code=404, detail="mídia não encontrada")
    return FileResponse(row["path"], media_type=row["mime"])
