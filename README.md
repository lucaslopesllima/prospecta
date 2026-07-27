# Rovva

SaaS multi-tenant de prospecção e gestão comercial para representantes. A partir de uma **base compartilhada da Receita Federal**, recomenda quais empresas abordar (por CNAE-alvo + proximidade + porte) e leva o lead do primeiro contato até o pedido pago.

---

## Funcionalidades

**Prospecção**
- Recomendação explicável de empresas (CNAE + geolocalização + porte), com lista e mapa
- Funil kanban, agenda de atividades, clientes e carteiras

**Comercial**
- Catálogo de produtos, tabelas de preço
- Pedidos, transportadoras, comissões e pedidos de amostra
- Multi-vendedor com metas

**Gestão**
- Dashboard e relatórios
- Financeiro (contas, categorias)
- Veículos e rotas de campo

**Comunicação**
- WhatsApp integrado: chat espelhado em tempo real, mídia, agendamentos
- E-mail agendado (SMTP por org, recorrência)

**Plataforma**
- Multi-tenant isolado por `org_id` (JWT); `companies` global entre tenants
- RBAC fino por grupos de permissão
- Auditoria, notificações, senhas com scrypt

## Stack

Fastify 5 + PostgreSQL 16/PostGIS + `pg` (SQL cru) · React 19 + Vite 6 + Tailwind 4 + Leaflet · Evolution API + Redis (WhatsApp) · ETL Node standalone (Receita Federal). Sem ORM.

---

## Como rodar

### Desenvolvimento (hot reload)

```bash
docker compose up
```

- UI: **http://localhost:5173** · API: `:8090` (`APP_PORT`) · Evolution: `:8081`
- Migrations rodam no boot. Acesse a UI → **Criar conta** (cria org + admin).
- Não precisa de `.env` no dev.

### Produção (VPS)

```bash
cp .env.example .env     # defina JWT_SECRET forte e POSTGRES_PASSWORD
./deploy.sh              # build + up -d + health + prune
```

### Carregar empresas (ETL RFB)

Baixe os CSVs abertos da Receita, monte num diretório e rode:

```bash
docker compose run --rm -v "$PWD/rfb-data:/data" app \
  node etl/etl.ts --uf SP --in /data \
    --estab ESTABELE --empresas EMPRE --simples SIMPLES \
    --municipio-map depara.csv --batch 5000
```

Filtra ativas, exclui MEI, preenche geolocalização e faz UPSERT. Re-runs atualizam sem duplicar.

---

## Estrutura

```
server/
  migrations/    # .sql versionadas + seeds/
  etl/etl.ts     # ETL Receita Federal -> companies
  src/routes/    # API por domínio (auth, recommend, orders, whatsapp, ...)
client/
  src/pages/     # React: Recommend, Kanban, Orders, WhatsApp, Dashboard, ...
docker-compose.yml       # DEV
docker-compose.prod.yml  # PROD
deploy.sh                # deploy VPS
docs/EXPLAIN.txt         # EXPLAIN ANALYZE da recomendação
```
