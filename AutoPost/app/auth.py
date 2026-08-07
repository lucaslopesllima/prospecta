"""Senha (bcrypt) e sessão via cookie assinado (itsdangerous)."""
import bcrypt
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import settings


def hash_password(senha: str) -> str:
    return bcrypt.hashpw(senha.encode(), bcrypt.gensalt()).decode()


def verify_password(senha: str, senha_hash: str) -> bool:
    try:
        return bcrypt.checkpw(senha.encode(), senha_hash.encode())
    except ValueError:
        return False


def _serializer(salt: str) -> URLSafeTimedSerializer:
    if not settings.session_secret:
        raise RuntimeError("SESSION_SECRET não configurada (use: python manage.py gen-keys)")
    return URLSafeTimedSerializer(settings.session_secret, salt=salt)


def create_session_token(user_id: int) -> str:
    return _serializer("session").dumps({"uid": user_id})


def read_session_token(token: str) -> int | None:
    try:
        data = _serializer("session").loads(token, max_age=settings.session_max_age)
        return int(data["uid"])
    except (BadSignature, SignatureExpired, KeyError, ValueError, TypeError):
        return None


def sign_media_token(media_id: int) -> str:
    """Link público temporário de mídia (necessário para publicar no Instagram)."""
    return _serializer("media").dumps({"m": media_id})


def read_media_token(token: str, max_age: int = 3600) -> int | None:
    try:
        data = _serializer("media").loads(token, max_age=max_age)
        return int(data["m"])
    except (BadSignature, SignatureExpired, KeyError, ValueError, TypeError):
        return None


def sign_oauth_state(user_id: int) -> str:
    return _serializer("oauth").dumps({"uid": user_id})


def read_oauth_state(state: str, max_age: int = 600) -> int | None:
    try:
        data = _serializer("oauth").loads(state, max_age=max_age)
        return int(data["uid"])
    except (BadSignature, SignatureExpired, KeyError, ValueError, TypeError):
        return None
