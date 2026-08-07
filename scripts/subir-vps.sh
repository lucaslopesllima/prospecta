#!/usr/bin/env bash
# Migração inicial p/ VPS — roda na SUA MÁQUINA (não na VPS).
#
# Faz, nesta ordem:
#   1. Empacota o volume do Postgres local (pgdata_dev) com zstd — a base já
#      carregada + índices vão prontos, sem re-rodar o ETL na VPS.
#   2. Envia o código (rsync, sem .git/node_modules/dados) e o tarball do banco.
#   3. Na VPS: instala docker se faltar, cria swap 2G, gera .env de produção
#      (segredos via openssl, tuning do Postgres calibrado pela RAM da VPS),
#      restaura o volume do banco e alinha a senha com o .env.
#   4. Chama ./deploy.sh (firewall + TLS + build + up).
#
# Uso (1ª vez — precisa do domínio já apontando pra VPS):
#   ./scripts/subir-vps.sh root@IP --domain rovva.exemplo.com.br --email voce@exemplo.com
#
# Reexecuções (código novo, banco já lá): só re-sincroniza e redeploya.
#   ./scripts/subir-vps.sh root@IP
#
# Flags:
#   --domain X --email Y   obrigatórios na 1ª vez (geram o .env na VPS)
#   --ssh-port N           porta SSH (default 22; após --lock-ssh use a custom)
#   --dir PATH             diretório remoto (default ~/rovva)
#   --repack               re-empacota o banco mesmo se o tarball já existe
#   --skip-db              não envia/restaura banco (só código + deploy)
#   --skip-deploy          prepara tudo mas não roda o deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# ── args ─────────────────────────────────────────────────────────────────────
TARGET="${1:-}"; shift || true
[ -n "$TARGET" ] || { echo "Uso: $0 usuario@ip [--domain X --email Y] [--ssh-port N] [--dir PATH] [--repack] [--skip-db] [--skip-deploy]" >&2; exit 1; }

DOMAIN="" ACME_EMAIL="" SSH_PORT=22 REMOTE_DIR="~/rovva"
REPACK=0 SKIP_DB=0 SKIP_DEPLOY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain)      DOMAIN="$2"; shift 2 ;;
    --email)       ACME_EMAIL="$2"; shift 2 ;;
    --ssh-port)    SSH_PORT="$2"; shift 2 ;;
    --dir)         REMOTE_DIR="$2"; shift 2 ;;
    --repack)      REPACK=1; shift ;;
    --skip-db)     SKIP_DB=1; shift ;;
    --skip-deploy) SKIP_DEPLOY=1; shift ;;
    *) echo "flag desconhecida: $1" >&2; exit 1 ;;
  esac
done

SSH=(ssh -p "$SSH_PORT" "$TARGET")
TARBALL="$HOME/.cache/rovva-deploy/pgdata.tar.zst"
# nome do volume local segue a convenção do compose: <dir-em-minúsculas>_pgdata_dev
LOCAL_VOL="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_pgdata_dev"

# ── 1. empacotar o banco local ───────────────────────────────────────────────
if [ "$SKIP_DB" = "1" ]; then
  echo "==> banco pulado (--skip-db)"
elif [ -s "$TARBALL" ] && [ "$REPACK" != "1" ]; then
  echo "==> tarball já existe ($(du -h "$TARBALL" | cut -f1)) — reaproveitando (use --repack p/ refazer)"
else
  docker volume inspect "$LOCAL_VOL" >/dev/null 2>&1 || { echo "ERRO: volume $LOCAL_VOL não existe" >&2; exit 1; }
  mkdir -p "$(dirname "$TARBALL")"
  echo "==> parando db local p/ cópia consistente"
  docker compose stop db
  echo "==> empacotando $LOCAL_VOL (34G+ -> zstd; alguns minutos)"
  docker run --rm -v "$LOCAL_VOL":/d:ro -v "$(dirname "$TARBALL")":/out alpine \
    sh -c "apk add --no-cache zstd >/dev/null && tar -cf - -C /d . | zstd -T0 -3 -o /out/$(basename "$TARBALL") -f"
  echo "==> religando db local"
  docker compose start db
  echo "    tarball pronto: $(du -h "$TARBALL" | cut -f1)"
fi

# ── 2. enviar código + tarball ───────────────────────────────────────────────
echo "==> testando SSH"
"${SSH[@]}" true

echo "==> rsync do código -> $TARGET:$REMOTE_DIR"
rsync -az --delete -e "ssh -p $SSH_PORT" \
  --exclude .git --exclude .env --exclude pgdata.tar.zst --exclude node_modules --exclude dist \
  --exclude dados_cnpj --exclude dados_cnefe --exclude MazyOS \
  --exclude __pycache__ --exclude '*.log' --exclude cloudflared.deb \
  --exclude marca --exclude e2e/test-results --exclude e2e/playwright-report \
  --exclude .venv --exclude .pytest_cache --exclude AutoPost/data \
  ./ "$TARGET:$REMOTE_DIR/"

if [ "$SKIP_DB" != "1" ]; then
  echo "==> enviando banco ($(du -h "$TARBALL" | cut -f1)) — rsync retoma se cair"
  rsync -aP --partial -e "ssh -p $SSH_PORT" "$TARBALL" "$TARGET:$REMOTE_DIR/pgdata.tar.zst"
fi

# ── 3+4. preparar VPS e deployar ─────────────────────────────────────────────
echo "==> executando preparação remota"
"${SSH[@]}" "DOMAIN='$DOMAIN' ACME_EMAIL='$ACME_EMAIL' REMOTE_DIR='$REMOTE_DIR' SKIP_DB='$SKIP_DB' SKIP_DEPLOY='$SKIP_DEPLOY' bash -s" <<'REMOTE'
set -euo pipefail
eval "cd $REMOTE_DIR"
SUDO=""; [ "$(id -u)" = "0" ] || SUDO="sudo"

# --- docker ---
if ! command -v docker >/dev/null 2>&1; then
  echo "==> [vps] instalando docker"
  curl -fsSL https://get.docker.com | $SUDO sh
fi

# --- swap 2G (segura picos de RAM no 8GB) ---
if ! $SUDO swapon --show | grep -q .; then
  echo "==> [vps] criando swap de 2G"
  $SUDO fallocate -l 2G /swapfile && $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile && $SUDO swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

# --- .env de produção (só na 1ª vez) ---
if [ ! -f .env ]; then
  [ -n "$DOMAIN" ] && [ -n "$ACME_EMAIL" ] || { echo "ERRO: 1ª execução precisa de --domain e --email (geram o .env)" >&2; exit 1; }
  echo "==> [vps] gerando .env (segredos novos + tuning pela RAM)"
  mem_gb=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 ))
  if [ "$mem_gb" -ge 12 ]; then
    SB=4GB; ECS=10GB; SHM=2g
  else
    SB=2GB; ECS=4GB; SHM=1g
  fi
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 16)|" \
      -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^EVOLUTION_API_KEY=.*|EVOLUTION_API_KEY=$(openssl rand -hex 32)|" \
      -e "s|^WHATSAPP_WEBHOOK_TOKEN=.*|WHATSAPP_WEBHOOK_TOKEN=$(openssl rand -hex 16)|" \
      -e "s|^DOMAIN=.*|DOMAIN=$DOMAIN|" \
      -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$ACME_EMAIL|" \
      -e "s|^PG_SHARED_BUFFERS=.*|PG_SHARED_BUFFERS=$SB|" \
      -e "s|^PG_EFFECTIVE_CACHE_SIZE=.*|PG_EFFECTIVE_CACHE_SIZE=$ECS|" \
      -e "s|^PG_SHM_SIZE=.*|PG_SHM_SIZE=$SHM|" \
      .env.example > .env
  chmod 600 .env
  echo "    RAM=${mem_gb}G -> shared_buffers=$SB effective_cache_size=$ECS"
fi

# --- checagem de DNS antes do deploy (o certbot falha se não apontar) ---
DOMAIN_ENV=$(grep '^DOMAIN=' .env | cut -d= -f2 | awk '{print $1}')
ip=$(curl -fsS --max-time 5 https://api.ipify.org || true)
# resolve via DoH (1.1.1.1) — getent local cai no /etc/hosts quando o domínio é
# o hostname da própria VPS (127.0.1.1) e dá falso negativo
dns=$(curl -fsS --max-time 5 -H 'accept: application/dns-json' \
  "https://1.1.1.1/dns-query?name=$DOMAIN_ENV&type=A" \
  | grep -oE '"data":"([0-9]{1,3}\.){3}[0-9]{1,3}"' | head -1 | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' || true)
if [ -n "$ip" ] && [ -n "$dns" ] && [ "$dns" != "$ip" ]; then
  echo "AVISO: DNS de $DOMAIN_ENV -> '$dns' mas o IP da VPS é '$ip'." >&2
  if [ "$SKIP_DEPLOY" != "1" ]; then
    echo "ERRO: aponte o A record antes, ou rode com --skip-deploy p/ deixar tudo pronto sem emitir cert." >&2
    exit 1
  fi
fi

# --- restaurar o banco (só se o volume ainda está vazio) ---
if [ "$SKIP_DB" != "1" ] && [ -s pgdata.tar.zst ]; then
  echo "==> [vps] criando volume do Postgres via compose"
  $SUDO docker compose -f docker-compose.prod.yml create db >/dev/null
  VOL="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')_pgdata"
  if $SUDO docker run --rm -v "$VOL":/d alpine test -f /d/PG_VERSION 2>/dev/null; then
    echo "==> [vps] volume $VOL já tem dados — restauração pulada"
  else
    echo "==> [vps] extraindo banco pro volume $VOL"
    $SUDO docker run --rm -v "$VOL":/d -v "$PWD":/in alpine \
      sh -c "apk add --no-cache zstd >/dev/null && zstd -dc /in/pgdata.tar.zst | tar -xf - -C /d"
    echo "==> [vps] subindo db e alinhando a senha com o .env"
    $SUDO docker compose -f docker-compose.prod.yml up -d db
    # -T e </dev/null: sem eles o exec consome o stdin do heredoc remoto e
    # engole o resto deste script (deploy nunca rodaria)
    for _ in $(seq 1 60); do
      $SUDO docker compose -f docker-compose.prod.yml exec -T db pg_isready -U postgres -d rs >/dev/null 2>&1 </dev/null && break
      sleep 2
    done
    PGPASS=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2 | awk '{print $1}')
    # volume veio do dev com senha antiga; o exec entra via socket local (trust)
    $SUDO docker compose -f docker-compose.prod.yml exec -T db \
      psql -U postgres -d rs -c "ALTER USER postgres WITH PASSWORD '$PGPASS';" >/dev/null </dev/null
    echo "    senha do Postgres alinhada ✓"
  fi
  rm -f pgdata.tar.zst
fi

# --- deploy ---
if [ "$SKIP_DEPLOY" = "1" ]; then
  echo "==> [vps] deploy pulado (--skip-deploy). Quando o DNS apontar: ssh na VPS e rode: sudo SKIP_GIT=1 ./deploy.sh"
else
  echo "==> [vps] rodando deploy.sh"
  $SUDO env SKIP_GIT=1 ./deploy.sh </dev/null
fi
REMOTE

echo ""
echo "==> concluído. Próximos passos:"
echo "    - conferir: https://SEU_DOMINIO/api/health"
echo "    - limpar dados de dev (tenants/usuários de teste) antes de abrir p/ cliente"
echo "    - depois de instalar sua chave SSH: sudo ./deploy.sh --lock-ssh na VPS"
