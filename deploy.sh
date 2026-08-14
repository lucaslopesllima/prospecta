#!/usr/bin/env bash
# Deploy de PRODUÇÃO — script único. Rode na VPS, dentro do diretório do projeto.
#
# Idempotente: na 1ª execução configura firewall/fail2ban e emite o certificado
# TLS; nas execuções seguintes detecta que já estão prontos e PULA direto pro
# build + up. Rode com sudo na 1ª vez (firewall precisa de root).
#
#   sudo ./deploy.sh          # 1ª vez: firewall + cert + build + up
#   ./deploy.sh               # reexecução: só git pull + build + up + health
#   SKIP_GIT=1 ./deploy.sh    # não faz git pull
#   SKIP_HARDEN=1 ./deploy.sh # não mexe no firewall/fail2ban
#   sudo ./deploy.sh --lock-ssh   # PASSO À PARTE: fecha SSH (só chave, sem root,
#                                 #   porta SSH_PORT). Só depois de confirmar login
#                                 #   por chave — senão te tranca pra fora.
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE=(docker compose -f docker-compose.prod.yml)

# --- .env obrigatório (produção, NÃO o dev) ---
if [ ! -f .env ]; then
  echo "ERRO: .env ausente. Rode: cp .env.example .env  e configure os segredos/DOMAIN." >&2
  exit 1
fi
set -a; . ./.env; set +a
SSH_PORT="${SSH_PORT:-2222}"

# ─────────────────────────────────────────────────────────────────────────────
# SSH hardening (opt-in, arriscado) — passo à parte, roda e sai.
# ─────────────────────────────────────────────────────────────────────────────
lock_ssh() {
  [ "$(id -u)" = "0" ] || { echo "ERRO: --lock-ssh precisa de root (sudo)." >&2; exit 1; }

  echo "==> --lock-ssh: verificando chaves autorizadas antes de fechar a senha"
  local found_key=0 home ak
  for home in /root /home/*; do
    ak="$home/.ssh/authorized_keys"
    [ -s "$ak" ] && { echo "    chave encontrada: $ak"; found_key=1; }
  done
  if [ "$found_key" != "1" ]; then
    echo "ERRO: nenhuma ~/.ssh/authorized_keys com conteúdo. Instale sua chave" >&2
    echo "      (ssh-copy-id) ANTES de fechar a senha — senão você se tranca." >&2
    exit 1
  fi

  echo "==> escrevendo config SSH endurecida (só chave, sem root, porta ${SSH_PORT})"
  cat >/etc/ssh/sshd_config.d/99-hardening.conf <<EOF
Port ${SSH_PORT}
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
X11Forwarding no
EOF

  echo "==> validando (sshd -t)"
  sshd -t

  # systemd socket-activation (Ubuntu 22.10+): a porta pode vir do ssh.socket.
  if systemctl list-unit-files 2>/dev/null | grep -q '^ssh.socket'; then
    mkdir -p /etc/systemd/system/ssh.socket.d
    printf '[Socket]\nListenStream=\nListenStream=%s\n' "${SSH_PORT}" \
      >/etc/systemd/system/ssh.socket.d/override.conf
    systemctl daemon-reload
    systemctl restart ssh.socket || true
  fi

  # garante a porta nova liberada no firewall antes de derrubar a sessão
  command -v ufw >/dev/null 2>&1 && ufw allow "${SSH_PORT}/tcp" comment 'ssh custom' || true

  systemctl restart ssh 2>/dev/null || systemctl restart sshd
  cat <<EOF

==> SSH fechado ✓  (só chave, sem root, porta ${SSH_PORT})

TESTE AGORA em OUTRO terminal (sem fechar este):
  ssh -p ${SSH_PORT} <usuario>@<ip-da-vps>
Funcionou? Feche a porta 22:   sudo ufw delete allow 22/tcp
Não funcionou? Reverta aqui:   sudo rm /etc/ssh/sshd_config.d/99-hardening.conf && sudo systemctl restart ssh
EOF
}

if [ "${1:-}" = "--lock-ssh" ]; then
  lock_ssh
  exit 0
fi

# --- validação dos segredos ---
: "${JWT_SECRET:?ERRO: defina JWT_SECRET no .env}"
: "${POSTGRES_PASSWORD:?ERRO: defina POSTGRES_PASSWORD no .env}"
: "${DOMAIN:?ERRO: defina DOMAIN no .env}"
: "${ACME_EMAIL:?ERRO: defina ACME_EMAIL no .env}"
case "${JWT_SECRET}" in
  ""|"change-this-to-a-long-random-secret"|"dev"|"dev-secret"|"integration-test-secret-please-change")
    echo "ERRO: JWT_SECRET inseguro. Gere um segredo forte (ex.: openssl rand -hex 32)." >&2
    exit 1 ;;
esac

# ─────────────────────────────────────────────────────────────────────────────
# 1. Hardening: firewall + fail2ban + updates automáticos (idempotente)
#    ufw/fail2ban/apt são idempotentes; detectamos "já feito" pela regra 443 no ufw.
# ─────────────────────────────────────────────────────────────────────────────
harden() {
  echo "==> hardening: firewall (ufw) + fail2ban + updates automáticos"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ufw fail2ban unattended-upgrades

  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp   comment 'ssh (padrão — remova após migrar p/ porta custom)'
  ufw allow "${SSH_PORT}/tcp" comment 'ssh custom'
  ufw allow 80/tcp   comment 'http (redirect + ACME)'
  ufw allow 443/tcp  comment 'https'
  ufw --force enable
  ufw status verbose

  cat >/etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
port    = 22,${SSH_PORT}
maxretry = 5
bantime = 1h
findtime = 10m
EOF
  systemctl enable --now fail2ban
  systemctl restart fail2ban

  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  echo "    hardening ✓  (SSH ainda aceita senha — feche com: sudo ./deploy.sh --lock-ssh)"
}

if [ "${SKIP_HARDEN:-0}" = "1" ]; then
  echo "==> hardening pulado (SKIP_HARDEN=1)"
elif [ "$(id -u)" != "0" ]; then
  echo "==> não-root: pulando firewall/fail2ban. Rode 'sudo ./deploy.sh' na 1ª vez p/ configurar. Seguindo."
elif ufw status 2>/dev/null | grep -q '443/tcp'; then
  echo "==> firewall/fail2ban já configurados — pulando"
else
  harden
fi

# --- atualizar código (se for um checkout git) ---
if [ -d .git ] && [ "${SKIP_GIT:-0}" != "1" ]; then
  echo "==> git pull --ff-only"
  git pull --ff-only
fi

echo "==> build da imagem de produção"
"${COMPOSE[@]}" build

# ─────────────────────────────────────────────────────────────────────────────
# 2. Certificado TLS (idempotente): emite na 1ª vez, pula se já existe.
#    Resolve o ovo-galinha do nginx: cria cert dummy p/ o nginx subir, troca pelo
#    real via desafio webroot e recarrega. Depois o serviço certbot renova sozinho.
# ─────────────────────────────────────────────────────────────────────────────
cert_path="/etc/letsencrypt/live/${DOMAIN}"
issue_cert() {
  echo "==> emitindo certificado TLS p/ ${DOMAIN} (Let's Encrypt)"
  echo "    (o A/AAAA record de ${DOMAIN} precisa apontar pra esta VPS e a porta 80 estar aberta)"
  local staging_arg=""
  [ "${STAGING:-0}" = "1" ] && staging_arg="--staging"
  # domínios extras no mesmo cert (ex.: CERT_EXTRA_DOMAINS="www.rovva.tech" no .env);
  # cada um precisa de A/CNAME apontando pra VPS, senão a emissão inteira falha
  local extra_d="" d
  for d in ${CERT_EXTRA_DOMAINS:-}; do extra_d="$extra_d -d $d"; done

  echo "==> cert dummy pro nginx conseguir subir"
  "${COMPOSE[@]}" run --rm --entrypoint sh certbot -c "\
    mkdir -p ${cert_path} && \
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout ${cert_path}/privkey.pem -out ${cert_path}/fullchain.pem -subj '/CN=localhost'"

  echo "==> subindo nginx com o cert dummy"
  "${COMPOSE[@]}" up -d nginx

  echo "==> removendo dummy e pedindo o cert real"
  "${COMPOSE[@]}" run --rm --entrypoint sh certbot -c "rm -rf ${cert_path}"
  "${COMPOSE[@]}" run --rm --entrypoint certbot certbot \
    certonly --webroot -w /var/www/certbot ${staging_arg} \
    --email "${ACME_EMAIL}" -d "${DOMAIN}" ${extra_d} --rsa-key-size 4096 \
    --agree-tos --no-eff-email --non-interactive

  echo "==> recarregando nginx com o cert real"
  "${COMPOSE[@]}" exec nginx nginx -s reload
}

if "${COMPOSE[@]}" run --rm --entrypoint sh certbot \
     -c "[ -s ${cert_path}/fullchain.pem ]" 2>/dev/null; then
  echo "==> cert TLS de ${DOMAIN} já existe — pulando emissão (certbot renova sozinho)"
else
  issue_cert
fi

echo "==> subindo a stack (migrations rodam no boot)"
"${COMPOSE[@]}" up -d

# app não é publicado no host (só o nginx expõe 80/443) — checa o healthcheck do container.
echo "==> aguardando health do container app (healthcheck interno)"
ok=0
cid="$("${COMPOSE[@]}" ps -q app)"
for _ in $(seq 1 45); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && { ok=1; break; }
  sleep 2
done
if [ "$ok" != "1" ]; then
  echo "ERRO: app não ficou healthy a tempo. Logs:" >&2
  "${COMPOSE[@]}" logs --tail=40 app >&2
  exit 1
fi
echo "    app healthy ✓"

# O app recriado recebe outro IP na rede Docker. Reinício completo do nginx
# força novos workers a resolverem o upstream, evitando 502 no IP antigo.
echo "==> reiniciando nginx para apontar ao app novo"
"${COMPOSE[@]}" restart nginx

# Domínio raiz redireciona para app, e curl considera 302 sucesso. Testar o host
# do app exige resposta 200 do proxy real, não só TLS/nginx de pé.
app_health_url="https://app.${DOMAIN}/api/health"
echo "==> checando HTTPS público em ${app_health_url}"
http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$app_health_url" || true)"
if [ "$http_code" = "200" ]; then
  echo "    HTTPS/proxy ok ✓"
else
  echo "ERRO: proxy público devolveu HTTP ${http_code:-sem resposta}. Logs nginx:" >&2
  "${COMPOSE[@]}" logs --tail=40 nginx >&2 || true
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Busca de empresas (idempotente): índices de prefixo + prewarm.
#    Fora do migrate.ts de propósito: o runner embrulha cada migration em
#    BEGIN/COMMIT e CREATE INDEX CONCURRENTLY não roda em transação — e sem
#    CONCURRENTLY o build (~minutos em 30M linhas) travaria escrita no boot.
#    1ª execução constrói os índices; nas seguintes vira no-op + prewarm.
# ─────────────────────────────────────────────────────────────────────────────
echo "==> índices de busca + prewarm (idempotente; 1ª vez demora alguns minutos)"
"${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-rs}" -v ON_ERROR_STOP=1 <<'SQL'
-- Build CONCURRENTLY interrompido deixa índice INVALID, e o IF NOT EXISTS
-- abaixo pularia o índice quebrado pra sempre — dropa antes.
DO $$
DECLARE i text;
BEGIN
  FOR i IN SELECT c.relname FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid
           WHERE NOT x.indisvalid
             AND c.relname IN ('companies_razao_prefix_idx', 'companies_fantasia_prefix_idx')
  LOOP
    EXECUTE format('DROP INDEX %I', i);
  END LOOP;
END $$;
-- COLLATE "C": banco é en_US.utf8; sem isso o planner não converte o LIKE 'X%'
-- da busca por prefixo em range scan. Casa com o COLLATE "C" da query em
-- server/src/routes/companies.ts (busca por nome).
CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_razao_prefix_idx
  ON companies (razao_social COLLATE "C");
CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_fantasia_prefix_idx
  ON companies (nome_fantasia COLLATE "C") WHERE nome_fantasia IS NOT NULL;
CREATE EXTENSION IF NOT EXISTS pg_prewarm;
-- Caminho quente da busca (btrees de prefixo/CNPJ) direto no shared_buffers;
-- GIN trigram (2,3GB, só fallback de substring) apenas no page cache do SO
-- ('read') pra não despejar o resto do shared_buffers. O autoprewarm
-- (docker-compose.prod.yml) preserva o cache entre restarts, mas não protege
-- contra eviction com o working set maior que o shared_buffers — daí reaquecer
-- a cada deploy.
SELECT pg_prewarm('companies_razao_prefix_idx'),
       pg_prewarm('companies_fantasia_prefix_idx'),
       pg_prewarm('companies_cnpj_prefix_idx');
SELECT pg_prewarm('companies_razao_trgm_idx', 'read'),
       pg_prewarm('companies_fantasia_trgm_idx', 'read');
SQL
echo "    busca ✓"

echo "==> limpando imagens antigas"
docker image prune -f >/dev/null || true

"${COMPOSE[@]}" ps
echo "==> deploy concluído."
