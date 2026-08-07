import os
import secrets

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Ambiente isolado por teste: banco, uploads e chaves próprias."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("LOG_FILE", str(tmp_path / "app.log"))
    monkeypatch.setenv("FERNET_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("SESSION_SECRET", secrets.token_urlsafe(32))
    monkeypatch.setenv("DISABLE_SCHEDULER", "1")
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://testserver")

    from app.config import settings

    settings.reload()
    yield settings


@pytest.fixture
def conn(env):
    from app import db

    c = db.connect()
    db.init_db(c)
    yield c
    c.close()


@pytest.fixture
def client(env):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


def make_user(conn, nome: str, email: str, senha: str = "senha12345") -> int:
    from app import auth, db

    return db.create_tenant_with_user(conn, nome, email, auth.hash_password(senha))


def login(client, email: str, senha: str = "senha12345"):
    """Retorna um cliente com o cookie de sessão daquele usuário."""
    r = client.post("/auth/login", json={"email": email, "senha": senha})
    assert r.status_code == 200, r.text
    return r.cookies["session"]
