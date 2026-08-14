# AutoPost

App leve de geração (IA), agendamento e publicação de posts em redes sociais.
Processo único, SQLite em WAL, sem serviços externos. Uso pessoal — 2 a 3 usuários.

## Instalação

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example .env
.venv/bin/python manage.py gen-keys      # copie as duas chaves para o .env
.venv/bin/python manage.py create-user --nome "Seu Nome" --email voce@exemplo.com
```

## Rodar

```bash
.venv/bin/uvicorn app.main:app --port 8000
```

Interface em `http://localhost:8000`, API em `/docs`.
**Um worker só** — o agendador vive no processo do app.

## CLI

| Comando | O que faz |
|---|---|
| `gen-keys` | Gera `FERNET_KEY` e `SESSION_SECRET` |
| `init-db` | Cria as tabelas |
| `create-user` | Cria usuário **e** o tenant dele (1 usuário = 1 tenant) |
| `reset-password` | Troca a senha de um usuário |
| `list-users` | Lista os usuários |
| `create-mcp-token` | Cria token MCP pessoal, com escopos e validade |
| `list-mcp-tokens` | Lista tokens MCP sem revelar segredos |
| `revoke-mcp-token` | Revoga token MCP imediatamente |

Não há registro público, convite nem recuperação de senha por e-mail — tudo passa por aqui.

## MCP remoto (Codex/ChatGPT desktop/IDE)

Endpoint Streamable HTTP: `https://autopost.seudominio.com.br/mcp`.

Guia para conectar outros agentes: [`MCP_AGENTS.md`](../MCP_AGENTS.md).

O MCP usa tokens pessoais por tenant. O banco guarda somente SHA-256 do segredo;
o token completo aparece uma vez na criação. Tokens expiram, podem ser revogados e
cada chamada de ferramenta entra em `mcp_audit_log`. O tenant vem do token validado,
nunca de argumento enviado pelo modelo.

Escopos disponíveis:

| Escopo | Ferramentas |
|---|---|
| `read` | listar contas, templates e posts |
| `generate` | gerar texto com a IA configurada (tem custo externo) |
| `write` | salvar rascunho; nunca publica |
| `schedule` | agendar publicação futura; conceda só quando necessário |

Crie token padrão, sem poder de publicação:

```bash
docker compose -f docker-compose.prod.yml exec autopost \
  python manage.py create-mcp-token --email voce@exemplo.com --nome codex
```

Guarde o valor retornado somente no ambiente local do Codex:

```bash
export AUTOPOST_MCP_TOKEN='autopost_mcp_...'
```

Configure `~/.codex/config.toml` (ou `.codex/config.toml` em projeto confiável):

```toml
[mcp_servers.autopost]
url = "https://autopost.seudominio.com.br/mcp"
bearer_token_env_var = "AUTOPOST_MCP_TOKEN"
enabled_tools = [
  "autopost_listar_contas",
  "autopost_listar_templates",
  "autopost_listar_posts",
  "autopost_gerar_post",
  "autopost_criar_rascunho",
]
default_tools_approval_mode = "writes"
```

Para permitir agendamento, emita outro token com escopo explícito:

```bash
docker compose -f docker-compose.prod.yml exec autopost \
  python manage.py create-mcp-token --email voce@exemplo.com --nome codex-agenda \
  --scopes read,generate,write,schedule --dias 30
```

Nesse perfil, adicione também `autopost_agendar_post` a `enabled_tools`. O modo
`writes` mantém aprovação antes da ação.

Revogue ao perder máquina/token:

```bash
docker compose -f docker-compose.prod.yml exec autopost \
  python manage.py revoke-mcp-token --email voce@exemplo.com --id ID
```

Controles adicionais: TLS no nginx, proteção Host/Origin contra DNS rebinding,
corpo MCP limitado a 1 MB, prompt limitado por `MCP_MAX_PROMPT_CHARS` e rate limit
por token (`MCP_RATE_LIMIT_PER_MINUTE`). Tokens nunca entram em logs ou respostas.

Carrosséis aceitam até 10 mídias ordenadas. `autopost_enviar_midia` recebe base64;
`autopost_criar_rascunho` recebe `media_ids`; `autopost_agendar_post` aceita
`placements` com `feed` e/ou `story`. Story usa primeira mídia como capa.

## Como o agendamento funciona

- Job a cada 60s busca posts vencidos (`scheduled_at <= agora`, em UTC).
- **Claim atômico** contra publicação duplicada:
  `UPDATE posts SET status='publishing' WHERE id=? AND status='scheduled'` —
  só publica quem afetar 1 linha.
- Até 3 tentativas, backoff de `tentativa × 120s`; depois `failed` com `last_error` legível.
- Cada tentativa entra em `publish_history`.
- **Catch-up na inicialização**: vencidos dentro de `CATCHUP_WINDOW_HOURS` (padrão 12h)
  saem ao subir o app; fora da janela viram `missed`.
- Posts presos em `publishing` (crash no meio) são recuperados — alvos que já
  tinham `external_post_id` nunca são repostados.

Limitação assumida: o agendador vive no processo. App desligado no horário, o post
não sai — mitigado pelo catch-up.

## Redes sociais

Dois conceitos distintos:

- **Credencial de app** — o client id/secret do *desenvolvedor* em cada plataforma.
  Fica em `social_credentials`, **uma por conta (tenant) e por rede**, cifrada. Não
  há herança do `.env`: quem não configurar, não conecta.
- **Conta conectada** — o token de uma página/perfil autorizado pelo OAuth, em
  `social_accounts`.

Para ligar qualquer rede:

1. Configure `PUBLIC_BASE_URL` no `.env` (compõe a URL de redirecionamento).
2. Em **Credenciais**, escolha a aba da rede, cole client id/secret e salve.
3. Copie a URL de redirecionamento mostrada na tela e cadastre-a no painel da
   plataforma — precisa bater caractere a caractere.
4. Clique em **Conectar conta** e autorize.

| Rede | Redirect URI | O que publica |
|---|---|---|
| Meta | `/accounts/meta/callback` | Facebook: texto e imagem. Instagram: **JPEG** obrigatório, por URL pública |
| TikTok | `/accounts/tiktok/callback` | Só vídeo, baixado por URL pública (`PULL_FROM_URL`) |
| LinkedIn | `/accounts/linkedin/callback` | Texto e imagem no feed do próprio perfil |

### Versões de API — precisam de manutenção anual

As três plataformas versionam e desativam versões antigas; chamada com versão
morta falha inteira, não degrada.

| Rede | Constante | Valor | Expira |
|---|---|---|---|
| Meta | `meta.GRAPH` | `v24.0` | fev/2028 ([changelog](https://developers.facebook.com/docs/graph-api/changelog/)) |
| LinkedIn | `linkedin.LINKEDIN_VERSION` | `202607` | ~jul/2027, mínimo 1 ano ([versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning)) |
| TikTok | — | v2, sem data | sem janela publicada |

Job diário (03:00 UTC) revalida os tokens. Expirado ou revogado vira status visível
na conta — nunca falha silenciosa. Tokens são criptografados com Fernet e nunca
aparecem em logs ou respostas da API; o secret só volta mascarado.

Instagram e TikTok exigem mídia por URL pública: o agendador gera um link assinado
e temporário (1h) em `/media/public/{token}` só para isso.

Restrições das plataformas, não do código:

- **TikTok** publica de forma **assíncrona**: o `video/init/` devolve um
  `publish_id` que é o processo, não o post. O provider acompanha
  `status/fetch/` até `PUBLISH_COMPLETE` (guarda o id real do post) ou `FAILED`
  (vira erro com o `fail_reason`), com teto de 90s — passado isso o upload já
  foi aceito e a moderação segue por conta do TikTok.
- **TikTok** exige `creator_info/query` antes de todo direct post, e o
  `privacy_level` enviado precisa estar entre os `privacy_level_options` que
  aquela chamada devolve — a lista muda com o tipo de conta e com o estado da
  auditoria do app. O provider consulta e escolhe o maior alcance disponível;
  app sem auditoria costuma receber só `SELF_ONLY` (post privado). O domínio de
  `PUBLIC_BASE_URL` também precisa estar verificado no painel do TikTok para o
  `PULL_FROM_URL` funcionar.
- **Instagram** aceita somente JPEG (PNG é recusado) e limita a 100 publicações
  por API em janela móvel de 24h.
- **LinkedIn** só emite `refresh_token` para apps aprovados no programa de
  refresh; sem ele, a reconexão ao expirar é manual. Além disso, um token com
  apenas `w_member_social` é write-only: não dá para consultar `/rest/images` e
  confirmar que a imagem terminou de processar antes de publicar — o 2xx do
  upload é a única garantia possível.

## Segurança e isolamento

- `tenant_id` em todas as tabelas de negócio; as rotas **nunca** aceitam `tenant_id`
  do cliente — ele é derivado da sessão, server-side.
- Todo SQL vive em `app/db.py`; as funções de negócio exigem `tenant_id`.
  As funções `sched_*` varrem todos os tenants e são de uso exclusivo do agendador.
- Uploads validam o MIME real (magic bytes) e o tamanho, e só são servidos por rota
  autenticada que checa o tenant. Não há diretório estático público de uploads.
- API keys de IA saem apenas mascaradas (`sk-...abc4`).

## Testes

```bash
.venv/bin/python -m pytest app/tests -q
```

72 testes, incluindo isolamento entre usuários e tokens MCP, publicação única sob
restart, catch-up/missed, revogação, escopos MCP e token social expirado.

## Backup

```bash
sqlite3 data/app.db ".backup data/backup.db"   # consistente com WAL
cp -r data/uploads /destino/
```

## Estrutura

```
app/
  main.py          # FastAPI + startup (pragmas, catch-up, agendador)
  db.py            # ÚNICO ponto de SQL
  auth.py          # senha (bcrypt) + sessão (cookie assinado)
  deps.py          # get_db / get_current_user
  crypto.py        # Fernet
  scheduler.py     # jobs: publicar vencidos, revalidar tokens
  config.py
  providers/
    social/meta.py         # Facebook + Instagram
    ai/openai.py, anthropic.py
    discovery/             # feature futura: temas de inspiração (só a interface)
  routes/          # auth, posts, accounts, ai, uploads, templates
  static/          # front-end (HTML + CSS + JS, sem build step)
  tests/
manage.py          # CLI
```

## Fora do escopo

Celery/Redis, Postgres, S3, billing, RBAC, convites, registro público,
recuperação de senha por e-mail, métricas externas.
