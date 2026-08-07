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

Não há registro público, convite nem recuperação de senha por e-mail — tudo passa por aqui.

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

## Meta (Facebook / Instagram)

1. Preencha `META_APP_ID`, `META_APP_SECRET` e `PUBLIC_BASE_URL` no `.env`.
2. Cadastre `PUBLIC_BASE_URL/accounts/meta/callback` como Redirect URI no app da Meta.
3. Em **Contas → Conectar Meta**: OAuth troca o code por token de longa duração e
   salva cada página do Facebook e cada conta Instagram Business vinculada.

Job diário (03:00 UTC) revalida os tokens. Expirado ou revogado vira status visível
na conta — nunca falha silenciosa. Tokens são criptografados com Fernet e nunca
aparecem em logs ou respostas da API.

Instagram só aceita mídia por URL pública (limitação da Graph API): o agendador gera
um link assinado e temporário (1h) em `/media/public/{token}` só para isso.

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

41 testes, incluindo isolamento entre dois usuários, publicação única sob restart,
catch-up/missed e token expirado.

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
