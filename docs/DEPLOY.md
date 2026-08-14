# Deploy em produção (VPS + nginx/TLS + hardening)

Tudo num script só: **`./deploy.sh`**. Idempotente — a 1ª execução configura
firewall/fail2ban e emite o certificado TLS; as seguintes detectam que já estão
prontos e vão direto pro build + up.

Arquitetura: **nginx** termina o TLS e faz proxy pro app pela rede interna do
compose; **certbot** renova o cert. Só 80/443 abertas na internet — Postgres,
Redis, Evolution e app não publicam porta no host.

```
internet ──443──> nginx ──(rede do compose)──> app:8080 ──> db / redis / evolution
           80 ──> nginx (redirect + desafio ACME)
```

## Pré-requisitos

- VPS Ubuntu/Debian com Docker + plugin compose.
- Domínio com A/AAAA record apontando pra VPS **antes** do 1º deploy (o certbot
  valida o domínio pela porta 80).

## 1. Configurar o `.env` (credenciais centralizadas)

Todas as credenciais num único `.env` (fora do git e do build da imagem). Nenhum
segredo hardcoded no compose.

```bash
cp .env.example .env
# preencha, no mínimo:
#   POSTGRES_PASSWORD       openssl rand -hex 16
#   JWT_SECRET              openssl rand -hex 32
#   EVOLUTION_API_KEY       openssl rand -hex 32
#   WHATSAPP_WEBHOOK_TOKEN  openssl rand -hex 16
#   DOMAIN                  seu domínio público
#   ACME_EMAIL              e-mail p/ avisos do Let's Encrypt
#   SSH_PORT               porta SSH custom (ex.: 2222)
#   PG_*                   tuning do Postgres pela RAM da VPS
```

## 2. Deploy

```bash
sudo ./deploy.sh
```

Na **1ª vez** (como root) o script:
1. Configura **ufw** (deny de entrada; libera só SSH + 80 + 443), **fail2ban** e
   updates de segurança automáticos.
2. Builda a imagem.
3. Emite o **certificado TLS** (dummy → real via Let's Encrypt → reload).
4. Sobe a stack, roda migrations no boot, espera o app *healthy*, reinicia o
   nginx para resolver o IP novo do container e exige HTTP 200 em
   `https://app.$DOMAIN/api/health`.

Nas **execuções seguintes** ele detecta firewall + cert já prontos e pula essas
etapas — só `git pull` + build + up + health.

```bash
sudo ./deploy.sh                  # deploy normal (pula o que já está feito)
STAGING=1 sudo ./deploy.sh        # 1ª emissão de cert no ambiente de teste do LE
SKIP_GIT=1 ./deploy.sh            # sem git pull
SKIP_HARDEN=1 ./deploy.sh         # não toca no firewall
```

> Rodar sem `sudo` funciona (se você estiver no grupo `docker`), mas aí o script
> pula firewall/fail2ban — rode `sudo ./deploy.sh` ao menos na 1ª vez.

## 3. Fechar o SSH (passo à parte — só depois de ter chave)

Fechar login por senha **antes** de ter chave = você se tranca pra fora. Por isso
é um comando separado, não roda no deploy automático.

Da sua máquina, garanta acesso por chave:
```bash
ssh-copy-id -p 22 usuario@ip
ssh -p 22 usuario@ip        # tem que entrar SEM pedir senha
```
Então, na VPS:
```bash
sudo ./deploy.sh --lock-ssh   # desativa senha + root, move SSH p/ SSH_PORT
# teste em OUTRO terminal:  ssh -p 2222 usuario@ip
# funcionou? feche a 22:    sudo ufw delete allow 22/tcp
```
O `--lock-ssh` recusa rodar se não achar `~/.ssh/authorized_keys` — anti-lockout.

## Portas expostas na internet

| Porta | Serviço | |
|---|---|---|
| `SSH_PORT` | SSH | só chave, sem root (após passo 3) |
| 80 | nginx | redirect p/ 443 + desafio ACME |
| 443 | nginx | HTTPS → app |

Postgres/Redis/Evolution/app: **sem porta no host**. Pra depurar, prenda em
loopback (`127.0.0.1:...`) — nunca `0.0.0.0`.

> **Docker × ufw:** o docker escreve iptables direto e ignora o ufw pras portas
> que *publica*. Como só o nginx publica (80/443, que devem ser públicas), não há
> vazamento. Se publicar algo pra debug, use `127.0.0.1:porta:porta`.

## Operação

- Cert renova sozinho (serviço `certbot`, 12h); nginx recarrega a cada 6h.
- Forçar renovação: `docker compose -f docker-compose.prod.yml run --rm certbot renew --force-renewal` e `... exec nginx nginx -s reload`.
- Logs: `docker compose -f docker-compose.prod.yml logs -f nginx app`.
