"""Configuração via variáveis de ambiente / .env.

`settings` é um objeto único; testes podem chamar settings.reload() após
alterar variáveis de ambiente.
"""
import os

from dotenv import load_dotenv


class Settings:
    def __init__(self) -> None:
        self.reload()

    def reload(self) -> None:
        load_dotenv(override=False)
        self.db_path = os.getenv("DB_PATH", "data/app.db")
        self.upload_dir = os.getenv("UPLOAD_DIR", "data/uploads")
        self.log_file = os.getenv("LOG_FILE", "data/app.log")
        self.fernet_key = os.getenv("FERNET_KEY", "")
        self.session_secret = os.getenv("SESSION_SECRET", "")
        self.session_max_age = int(os.getenv("SESSION_MAX_AGE", "604800"))
        self.catchup_window_hours = int(os.getenv("CATCHUP_WINDOW_HOURS", "12"))
        self.max_upload_mb = int(os.getenv("MAX_UPLOAD_MB", "20"))
        # Credenciais de app (Meta/TikTok/LinkedIn) NÃO vêm do ambiente: são por
        # tenant, na tabela social_credentials. Ver app/routes/credentials.py.
        self.public_base_url = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
        self.mcp_rate_limit_per_minute = int(os.getenv("MCP_RATE_LIMIT_PER_MINUTE", "120"))
        self.mcp_max_prompt_chars = int(os.getenv("MCP_MAX_PROMPT_CHARS", "12000"))
        # Usado nos testes para não subir o APScheduler
        self.disable_scheduler = os.getenv("DISABLE_SCHEDULER", "") == "1"


settings = Settings()
