"""FastAPI + startup: pragmas/schema, catch-up e agendador in-process.

Rodar com: uvicorn app.main:app (1 worker — o agendador vive no processo).
"""
import logging
import logging.handlers
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import db, scheduler
from app.config import settings
from app.routes import accounts, ai, auth_routes, credentials, posts, templates, uploads


def setup_logging() -> None:
    logger = logging.getLogger("autopost")
    if logger.handlers:
        return
    logger.setLevel(logging.INFO)
    parent = os.path.dirname(settings.log_file)
    if parent:
        os.makedirs(parent, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        settings.log_file, maxBytes=5 * 1024 * 1024, backupCount=3
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    conn = db.connect()
    try:
        db.init_db(conn)
        scheduler.catch_up(conn)
    finally:
        conn.close()
    if not settings.disable_scheduler:
        scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="AutoPost", lifespan=lifespan)

app.include_router(auth_routes.router)
app.include_router(posts.router)
app.include_router(credentials.router)
app.include_router(accounts.router)
app.include_router(ai.router)
app.include_router(uploads.router)
app.include_router(templates.router)


@app.get("/health")
def health():
    return {"ok": True}


# Front-end estático (HTML/CSS/JS próprios — não expõe uploads).
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

NO_CACHE = "no-cache"  # revalida sempre; o ETag ainda evita rebaixar o arquivo


class RevalidatingStatic(StaticFiles):
    """Sem isto o navegador segura CSS/JS antigos depois de uma edição."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = NO_CACHE
        return response


app.mount("/app", RevalidatingStatic(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(
        os.path.join(STATIC_DIR, "index.html"),
        headers={"Cache-Control": NO_CACHE},
    )
