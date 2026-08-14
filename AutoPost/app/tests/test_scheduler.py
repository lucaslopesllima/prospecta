"""Critérios de aceite 2, 3 e 4: publicação única, catch-up/missed e token expirado."""
from datetime import datetime, timedelta, timezone

import pytest

from app import crypto, db, scheduler
from app.providers import social
from app.tests.conftest import make_user


def fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def past(**kw) -> str:
    return fmt(datetime.now(timezone.utc) - timedelta(**kw))


@pytest.fixture
def setup(conn):
    uid = make_user(conn, "Alice", "alice@ex.com")
    tenant_id = db.get_user(conn, uid)["tenant_id"]
    account_id = db.upsert_social_account(
        conn, tenant_id, "facebook", "page-1", "Página",
        crypto.encrypt("token-valido"), None,
    )
    return tenant_id, account_id


class FakeProvider:
    """Conta quantas vezes publish foi chamado e permite forçar falhas."""

    def __init__(self, exc: Exception | None = None):
        self.calls = 0
        self.exc = exc

    async def publish(self, external_id, access_token, texto, **kw):
        self.calls += 1
        if self.exc:
            raise self.exc
        return f"ext-{self.calls}"

    async def validate(self, external_id, access_token):
        if isinstance(self.exc, social.TokenExpired):
            raise self.exc
        return True


@pytest.fixture
def fake(monkeypatch):
    provider = FakeProvider()
    monkeypatch.setattr(social, "get_provider", lambda name: provider)
    monkeypatch.setattr("app.scheduler.social.get_provider", lambda name: provider)
    return provider


def schedule(conn, tenant_id, account_id, when: str, texto="oi") -> int:
    post_id = db.create_post(conn, tenant_id, texto)
    assert db.schedule_post(conn, tenant_id, post_id, when, [account_id])
    return post_id


def test_feed_e_story_criam_alvos_independentes(conn, setup):
    tenant_id, account_id = setup
    post_id = db.create_post(conn, tenant_id, "oi")
    assert db.schedule_post(
        conn, tenant_id, post_id, past(minutes=5), [account_id], ["feed", "story"]
    )
    assert [t["placement"] for t in db.list_targets(conn, tenant_id, post_id)] == [
        "feed", "story"
    ]


# ---- Critério 2: publica exatamente 1 vez ----------------------------------

@pytest.mark.anyio
async def test_publica_uma_unica_vez_mesmo_com_varias_rodadas(conn, setup, fake):
    tenant_id, account_id = setup
    post_id = schedule(conn, tenant_id, account_id, past(minutes=5))

    await scheduler.publish_due_job()
    await scheduler.publish_due_job()
    await scheduler.publish_due_job()

    assert fake.calls == 1
    post = db.get_post(conn, tenant_id, post_id)
    assert post["status"] == "published"
    assert post["published_at"] is not None


def test_claim_atomico_so_deixa_um_vencer(conn, setup):
    tenant_id, account_id = setup
    post_id = schedule(conn, tenant_id, account_id, past(minutes=5))
    assert db.sched_claim(conn, post_id) is True
    assert db.sched_claim(conn, post_id) is False


@pytest.mark.anyio
async def test_restart_durante_publicacao_nao_reposta_alvo_ja_publicado(conn, setup, fake):
    """Simula crash com 1 de 2 alvos já publicado: só o pendente é reprocessado."""
    tenant_id, account_id = setup
    account2 = db.upsert_social_account(
        conn, tenant_id, "facebook", "page-2", "Página 2",
        crypto.encrypt("token-2"), None,
    )
    post_id = schedule(conn, tenant_id, account_id, past(minutes=5))
    db.schedule_post(conn, tenant_id, post_id, past(minutes=5), [account_id, account2])

    # Estado de crash: post em 'publishing', primeiro alvo já publicado.
    db.sched_claim(conn, post_id)
    targets = db.list_targets(conn, tenant_id, post_id)
    db.sched_finish_target(conn, targets[0]["id"], "published", "ext-antigo", None)

    scheduler.catch_up(conn)  # recovery de inicialização
    assert db.get_post(conn, tenant_id, post_id)["status"] == "scheduled"

    await scheduler.publish_due_job()

    assert fake.calls == 1  # só o alvo pendente
    assert db.get_post(conn, tenant_id, post_id)["status"] == "published"
    published = [t for t in db.list_targets(conn, tenant_id, post_id) if t["status"] == "published"]
    assert len(published) == 2
    assert any(t["external_post_id"] == "ext-antigo" for t in published)


def test_recovery_marca_publicado_quando_todos_alvos_ok(conn, setup):
    tenant_id, account_id = setup
    post_id = schedule(conn, tenant_id, account_id, past(minutes=5))
    db.sched_claim(conn, post_id)
    for t in db.list_targets(conn, tenant_id, post_id):
        db.sched_finish_target(conn, t["id"], "published", "ext-1", None)

    scheduler.catch_up(conn)
    assert db.get_post(conn, tenant_id, post_id)["status"] == "published"


# ---- Critério 3: catch-up dentro da janela, missed fora ---------------------

@pytest.mark.anyio
async def test_catchup_publica_dentro_da_janela(conn, setup, fake, env):
    tenant_id, account_id = setup
    post_id = schedule(conn, tenant_id, account_id, past(hours=2))  # janela = 12h

    scheduler.catch_up(conn)
    assert db.get_post(conn, tenant_id, post_id)["status"] == "scheduled"

    await scheduler.publish_due_job()
    assert db.get_post(conn, tenant_id, post_id)["status"] == "published"
    assert fake.calls == 1


@pytest.mark.anyio
async def test_catchup_marca_missed_fora_da_janela(conn, setup, fake, env):
    tenant_id, account_id = setup
    post_id = schedule(conn, tenant_id, account_id, past(hours=48))

    scheduler.catch_up(conn)

    post = db.get_post(conn, tenant_id, post_id)
    assert post["status"] == "missed"
    assert "catch-up" in post["last_error"]

    await scheduler.publish_due_job()
    assert fake.calls == 0


@pytest.mark.anyio
async def test_post_futuro_nao_e_publicado(conn, setup, fake):
    tenant_id, account_id = setup
    future = fmt(datetime.now(timezone.utc) + timedelta(hours=1))
    post_id = schedule(conn, tenant_id, account_id, future)

    scheduler.catch_up(conn)
    await scheduler.publish_due_job()

    assert fake.calls == 0
    assert db.get_post(conn, tenant_id, post_id)["status"] == "scheduled"


# ---- Retries e falhas ------------------------------------------------------

@pytest.mark.anyio
async def test_retry_com_backoff_e_falha_apos_max_tentativas(conn, setup, monkeypatch):
    tenant_id, account_id = setup
    provider = FakeProvider(social.PublishError("API fora do ar"))
    monkeypatch.setattr("app.scheduler.social.get_provider", lambda name: provider)
    post_id = schedule(conn, tenant_id, account_id, past(minutes=5))

    for tentativa in range(1, scheduler.MAX_ATTEMPTS + 1):
        # Força o vencimento do backoff para a próxima rodada.
        db.sched_post_retry(conn, post_id, tentativa - 1, past(minutes=1),
                            db.get_post(conn, tenant_id, post_id)["last_error"] or "")
        await scheduler.publish_due_job()
        post = db.get_post(conn, tenant_id, post_id)
        if tentativa < scheduler.MAX_ATTEMPTS:
            assert post["status"] == "scheduled", f"tentativa {tentativa}"

    post = db.get_post(conn, tenant_id, post_id)
    assert post["status"] == "failed"
    assert post["attempts"] == scheduler.MAX_ATTEMPTS
    assert "API fora do ar" in post["last_error"]
    assert len(db.list_history(conn, tenant_id, post_id)) == scheduler.MAX_ATTEMPTS


# ---- Critério 4: token expirado vira status visível ------------------------

@pytest.mark.anyio
async def test_token_expirado_na_publicacao_marca_conta(conn, setup, monkeypatch):
    tenant_id, account_id = setup
    provider = FakeProvider(social.TokenExpired("token inválido"))
    monkeypatch.setattr("app.scheduler.social.get_provider", lambda name: provider)
    post_id = schedule(conn, tenant_id, account_id, past(minutes=5))

    await scheduler.publish_due_job()

    assert db.get_social_account(conn, tenant_id, account_id)["status"] == "expired"
    post = db.get_post(conn, tenant_id, post_id)
    assert post["status"] == "scheduled"  # ainda vai tentar de novo
    assert "token expirado" in post["last_error"]
    history = db.list_history(conn, tenant_id, post_id)
    assert history[0]["status"] == "failed"


@pytest.mark.anyio
async def test_job_diario_marca_token_expirado(conn, setup, monkeypatch):
    tenant_id, account_id = setup
    provider = FakeProvider(social.TokenExpired("expirado"))
    monkeypatch.setattr("app.scheduler.social.get_provider", lambda name: provider)

    await scheduler.refresh_tokens_job()

    account = db.get_social_account(conn, tenant_id, account_id)
    assert account["status"] == "expired"
    assert account["last_checked_at"] is not None


# ---- Critério 5: nenhum segredo em respostas -------------------------------

def test_token_nunca_aparece_na_api(client, conn, setup):
    from app.tests.conftest import login

    tenant_id, _ = setup
    login(client, "alice@ex.com")
    body = client.get("/accounts").text
    assert "token-valido" not in body
    assert "access_token" not in body
