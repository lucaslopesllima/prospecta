"""Agendador in-process (APScheduler) + catch-up de inicialização.

Jobs:
- publish_due_job: a cada 60s publica posts vencidos (claim atômico).
- refresh_tokens_job: diário, valida tokens; expirado vira status visível.

Limitação assumida: o agendador vive no processo do app — app desligado no
horário, post não sai (mitigado pelo catch-up na inicialização).
"""
import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app import auth, crypto, db
from app.config import settings
from app.providers import social

log = logging.getLogger("autopost")

MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 120  # backoff simples: attempts * 120s

_scheduler: AsyncIOScheduler | None = None


def _now_dt() -> datetime:
    return datetime.now(timezone.utc)


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def catch_up(conn) -> None:
    """Na inicialização: fora da janela vira 'missed'; presos em 'publishing'
    são recuperados (alvos já publicados nunca são repostados)."""
    cutoff = _fmt(_now_dt() - timedelta(hours=settings.catchup_window_hours))
    missed = db.sched_mark_missed(conn, cutoff)
    if missed:
        log.warning("catch-up: %d posts marcados como missed (antes de %s UTC)", missed, cutoff)
    db.sched_recover_publishing(conn)


async def publish_due_job() -> None:
    conn = db.connect()
    try:
        due = db.sched_due_posts(conn, _fmt(_now_dt()))
        for post in due:
            # Claim atômico contra publicação duplicada.
            if not db.sched_claim(conn, post["id"]):
                continue
            await _publish_post(conn, post)
    finally:
        conn.close()


async def _publish_post(conn, post) -> None:
    tenant_id = post["tenant_id"]
    post_id = post["id"]
    attempt = post["attempts"] + 1
    log.info("tenant=%s post=%s publicando (tentativa %d)", tenant_id, post_id, attempt)

    media = db.sched_get_media(conn, post["media_id"]) if post["media_id"] else None
    media_url = None
    if media and settings.public_base_url:
        media_url = f"{settings.public_base_url}/media/public/{auth.sign_media_token(media['id'])}"

    errors: list[str] = []
    for target in db.sched_pending_targets(conn, post_id):
        account = db.sched_get_account(conn, target["social_account_id"])
        try:
            if account is None:
                raise social.PublishError("conta social não existe mais")
            if account["status"] != "connected":
                raise social.PublishError(f"conta '{account['name']}' com status {account['status']}")
            provider = social.get_provider(account["provider"])
            external_id = await provider.publish(
                account["external_id"],
                crypto.decrypt(account["access_token"]),
                post["texto"],
                media_path=media["path"] if media else None,
                media_mime=media["mime"] if media else None,
                media_url=media_url,
            )
            db.sched_finish_target(conn, target["id"], "published", external_id, None)
            db.add_history(conn, tenant_id, post_id, target["social_account_id"],
                           attempt, "published", None)
        except social.TokenExpired as e:
            if account is not None:
                db.set_account_status(conn, tenant_id, account["id"], "expired")
            err = f"token expirado: {e}"
            errors.append(err)
            db.sched_finish_target(conn, target["id"], "failed", None, err)
            db.add_history(conn, tenant_id, post_id, target["social_account_id"],
                           attempt, "failed", err)
        except Exception as e:
            err = str(e)[:500]
            errors.append(err)
            db.sched_finish_target(conn, target["id"], "failed", None, err)
            db.add_history(conn, tenant_id, post_id, target["social_account_id"],
                           attempt, "failed", err)
            log.warning("tenant=%s post=%s alvo=%s falhou: %s",
                        tenant_id, post_id, target["id"], err)

    if not errors:
        db.sched_post_published(conn, post_id)
        log.info("tenant=%s post=%s publicado", tenant_id, post_id)
        return

    error_msg = "; ".join(errors)[:1000]
    if attempt >= MAX_ATTEMPTS:
        db.sched_post_failed(conn, post_id, attempt, error_msg)
        log.error("tenant=%s post=%s falhou definitivamente após %d tentativas: %s",
                  tenant_id, post_id, attempt, error_msg)
    else:
        next_at = _fmt(_now_dt() + timedelta(seconds=attempt * RETRY_BACKOFF_SECONDS))
        db.sched_reset_failed_targets(conn, post_id)
        db.sched_post_retry(conn, post_id, attempt, next_at, error_msg)
        log.warning("tenant=%s post=%s retry agendado para %s UTC", tenant_id, post_id, next_at)


async def refresh_tokens_job() -> None:
    conn = db.connect()
    try:
        for account in db.sched_all_accounts(conn):
            try:
                provider = social.get_provider(account["provider"])
                await provider.validate(
                    account["external_id"], crypto.decrypt(account["access_token"])
                )
                status = "connected"
            except social.TokenExpired:
                status = "expired"
                log.warning("tenant=%s conta=%s token expirado",
                            account["tenant_id"], account["id"])
            except Exception as e:
                status = "error"
                log.warning("tenant=%s conta=%s erro na validação: %s",
                            account["tenant_id"], account["id"], str(e)[:200])
            db.set_account_status(conn, account["tenant_id"], account["id"], status)
    finally:
        conn.close()


def start() -> None:
    global _scheduler
    _scheduler = AsyncIOScheduler(timezone="UTC")
    _scheduler.add_job(publish_due_job, "interval", seconds=60, id="publish_due",
                       max_instances=1, coalesce=True)
    _scheduler.add_job(refresh_tokens_job, "cron", hour=3, minute=0, id="refresh_tokens")
    _scheduler.start()
    log.info("agendador iniciado (publicação a cada 60s, tokens diário 03:00 UTC)")


def shutdown() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
