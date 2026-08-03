#!/usr/bin/env bash
# Wrapper da rotina de atualização da base CNPJ.
# Sobe o banco (se preciso) e roda atualizar_cnpj.py num container Python na
# rede do compose. Repassa qualquer argumento ao script.
#
#   ./atualizar.sh                 # atualiza só se a fonte mudou
#   ./atualizar.sh --so-checar     # só verifica, não baixa
#   ./atualizar.sh --force         # roda mesmo sem mudança
#   ./atualizar.sh --mes 2026-06   # mês específico
#
# Depois de uma carga de verdade, recalcula contato_compartilhado (telefones e
# e-mails de contabilidade). Sem isso, empresa nova fica sem o aviso e contato
# que deixou de ser compartilhado continua marcado. Pule com PULAR_CONTATOS=1.
#
# Overrides por env: REDE, DATABASE_URL, PY_IMAGE, PULAR_CONTATOS.
set -euo pipefail

cd "$(dirname "$0")"

REDE="${REDE:-representativeseller_default}"
DATABASE_URL="${DATABASE_URL:-postgres://postgres:postgres@db:5432/rs}"
PY_IMAGE="${PY_IMAGE:-python:3.12-slim}"

# garante o banco no ar e saudável
echo ">> subindo banco (se necessário)…"
docker compose up -d db >/dev/null
until [ "$(docker inspect representativeseller-db-1 --format '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ]; do
  sleep 2
done

# confere que a rede existe
if ! docker network inspect "$REDE" >/dev/null 2>&1; then
  echo "!! rede '$REDE' não encontrada. Rode 'docker compose up -d' primeiro ou defina REDE=..." >&2
  exit 1
fi

echo ">> executando rotina de atualização…"
# Sem `exec`: precisamos do controle de volta para o recálculo abaixo.
# O log passa por tee — continua na tela e sobra em disco para inspeção.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
set +e
docker run --rm \
  --network "$REDE" \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PYTHONUNBUFFERED=1 \
  -v "$PWD:/work" -w /work \
  "$PY_IMAGE" \
  bash -c 'pip install -q --disable-pip-version-check --root-user-action=ignore requests psycopg2-binary && python atualizar_cnpj.py "$@"' _ "$@" | tee "$LOG"
STATUS=${PIPESTATUS[0]}
set -e
[ "$STATUS" -eq 0 ] || exit "$STATUS"

# "Manifesto salvo" só sai quando a carga realmente rodou. Fonte sem mudança e
# --so-checar terminam com status 0 sem essa linha, e aí não há o que recalcular
# (a varredura leva ~13 min na VPS — não vale rodar à toa).
if ! grep -q 'Manifesto salvo' "$LOG"; then
  echo ">> nenhuma carga nova — contato_compartilhado mantido."
  exit 0
fi
if [ "${PULAR_CONTATOS:-0}" = "1" ]; then
  echo ">> recálculo de contato_compartilhado pulado (PULAR_CONTATOS=1)."
  exit 0
fi

echo ">> recalculando contato_compartilhado (contatos de contabilidade)…"
docker compose up -d app >/dev/null
docker compose exec -T app node scripts/contatos-compartilhados.ts
