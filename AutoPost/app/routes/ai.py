import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app import crypto, db
from app.deps import get_current_user, get_db
from app.providers import ai as ai_providers

router = APIRouter(prefix="/ai", tags=["ai"])


class AISettingsIn(BaseModel):
    provider: str  # openai | anthropic
    api_key: str | None = None  # None mantém a chave atual
    model: str
    default_prompt: str | None = None
    temperature: float | None = None
    extra_params: dict | None = None


class GenerateIn(BaseModel):
    prompt: str | None = None
    template_id: int | None = None


def _settings_out(row: sqlite3.Row) -> dict:
    # api_key sai apenas mascarada.
    return {
        "provider": row["provider"],
        "api_key": crypto.mask(crypto.decrypt(row["api_key"])),
        "model": row["model"],
        "default_prompt": row["default_prompt"],
        "temperature": row["temperature"],
        "extra_params": json.loads(row["extra_params"]) if row["extra_params"] else None,
    }


@router.get("/settings")
def get_settings_route(
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    row = db.get_ai_settings(conn, user["tenant_id"])
    if row is None:
        raise HTTPException(status_code=404, detail="IA não configurada")
    return _settings_out(row)


@router.put("/settings")
def put_settings(
    body: AISettingsIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    if body.provider not in ("openai", "anthropic"):
        raise HTTPException(status_code=422, detail="provider deve ser openai ou anthropic")
    current = db.get_ai_settings(conn, user["tenant_id"])
    if body.api_key:
        api_key_enc = crypto.encrypt(body.api_key)
    elif current is not None:
        api_key_enc = current["api_key"]
    else:
        raise HTTPException(status_code=422, detail="api_key é obrigatória na primeira configuração")
    db.upsert_ai_settings(
        conn, user["tenant_id"], body.provider, api_key_enc, body.model,
        body.default_prompt, body.temperature,
        json.dumps(body.extra_params) if body.extra_params else None,
    )
    return _settings_out(db.get_ai_settings(conn, user["tenant_id"]))


@router.post("/generate")
async def generate(
    body: GenerateIn,
    user: sqlite3.Row = Depends(get_current_user),
    conn: sqlite3.Connection = Depends(get_db),
):
    cfg = db.get_ai_settings(conn, user["tenant_id"])
    if cfg is None:
        raise HTTPException(status_code=422, detail="configure a IA em /ai/settings antes")

    prompt = body.prompt
    if body.template_id is not None:
        tpl = db.get_template(conn, user["tenant_id"], body.template_id)
        if tpl is None:
            raise HTTPException(status_code=404, detail="template não encontrado")
        prompt = f"{tpl['conteudo']}\n\n{prompt}" if prompt else tpl["conteudo"]
    if not prompt:
        if not cfg["default_prompt"]:
            raise HTTPException(status_code=422, detail="informe um prompt ou configure default_prompt")
        prompt = cfg["default_prompt"]
    elif cfg["default_prompt"] and body.prompt:
        prompt = f"{cfg['default_prompt']}\n\n{prompt}"

    try:
        text = await ai_providers.generate_text(
            cfg["provider"], crypto.decrypt(cfg["api_key"]), cfg["model"], prompt,
            cfg["temperature"],
            json.loads(cfg["extra_params"]) if cfg["extra_params"] else None,
        )
    except ai_providers.AIError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"texto": text}
