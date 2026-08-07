import logging
import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from app import auth, db
from app.config import settings
from app.deps import get_current_user, get_db

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("autopost")


class LoginIn(BaseModel):
    email: str
    senha: str


def _user_out(user: sqlite3.Row) -> dict:
    return {
        "id": user["id"],
        "tenant_id": user["tenant_id"],
        "nome": user["nome"],
        "email": user["email"],
    }


@router.post("/login")
def login(body: LoginIn, response: Response, conn: sqlite3.Connection = Depends(get_db)):
    user = db.get_user_by_email(conn, body.email)
    if user is None or not auth.verify_password(body.senha, user["senha_hash"]):
        raise HTTPException(status_code=401, detail="e-mail ou senha inválidos")
    db.touch_last_login(conn, user["id"])
    token = auth.create_session_token(user["id"])
    response.set_cookie(
        "session", token,
        max_age=settings.session_max_age,
        httponly=True, samesite="lax",
    )
    log.info("tenant=%s login user=%s", user["tenant_id"], user["id"])
    return _user_out(user)


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie("session")
    return {"ok": True}


@router.get("/me")
def me(user: sqlite3.Row = Depends(get_current_user)):
    return _user_out(user)
