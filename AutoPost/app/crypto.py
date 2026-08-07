"""Helpers Fernet para segredos em repouso (tokens sociais, API keys de IA)."""
from cryptography.fernet import Fernet

from app.config import settings


def _fernet() -> Fernet:
    if not settings.fernet_key:
        raise RuntimeError("FERNET_KEY não configurada (use: python manage.py gen-keys)")
    return Fernet(settings.fernet_key.encode())


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    return _fernet().decrypt(value.encode()).decode()


def mask(secret: str) -> str:
    """Máscara para exibição: 'sk-...abc4'. Nunca retornar o segredo inteiro."""
    if not secret:
        return ""
    if len(secret) <= 10:
        return "***"
    return f"{secret[:3]}...{secret[-4:]}"
