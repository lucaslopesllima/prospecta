# Plano: Cobertura E2E 100% com Playwright — Rovva

## Contexto

O app (SaaS multi-tenant CRM/prospecção — React 19 + Vite, Fastify 5, Postgres/PostGIS via docker compose) tem hoje ~225 testes de integração de API (Vitest + `fastify.inject` + banco `rs_test`) e ~148 testes de componente (jsdom). **Não existe nenhum e2e de browser, nem Playwright, nem CI.** Objetivo: cobrir 100% da aplicação com e2e Playwright — "100%" definido pragmaticamente como **rota × fluxo de usuário × permissão** (não linha de código), com checklist mensurável.

Decisões: Playwright roda no **host** (stack no docker); **CI GitHub Actions** entra como fase final; **PWA/offline entra no escopo**.

## Fatos verificados no código

- Token de sessão: `localStorage` chave `rs_token` (`client/src/lib/api.ts:2`).
- `POST /api/auth/register` retorna **201** com `{token, user}`; cria org + admin + 7 etapas de funil + grupos RBAC padrão (Administrador/Vendedor/Gerente/Financeiro).
- Guards em `client/src/App.tsx`: `RequireAuth`, `RequirePermission(code)` (15 codes), `RequireOffice` (3 rotas: /carteiras, /equipe, /grupos).
- Kanban usa **HTML5 DnD nativo** (`draggable` + `onDragStart`, `client/src/pages/Kanban.tsx:293`).
- URLs externas **hardcoded no server**: Nominatim/BrasilAPI (`server/src/geocode.ts`), OSRM (`server/src/routes/routes.ts`) — `page.route` não alcança chamadas server-side; precisa extrair para env + stub HTTP local.
- Padrões a espelhar: `server/test/helpers.ts` (`register()`, `makeCompany()`, `mail()`, `uniq()`) e `server/test/setup.ts` (cria DB, migrations via `server/scripts/migrate-lib.ts`, truncate `companies`).
- Sem seed de dados de negócio; `companies` vem de ETL da Receita (ausente em dev) — prospecção exige seed SQL próprio.
- Rate-limit de auth contornável com `AUTH_RATE_LIMIT_MAX` alto (mesmo bypass do Vitest).
- Evolution API URL já é env (`EVOLUTION_API_URL`); mensagens recebidas podem ser simuladas via `POST /api/webhooks/whatsapp?token=...` (exercita webhook→DB→WS→UI real).

## Estrutura

Workspace novo `e2e/` na raiz (package.json próprio, independente de client/server):

```
e2e/
├── package.json              # @playwright/test, pg, dotenv
├── tsconfig.json
├── playwright.config.ts      # chromium default; projects: chromium, mobile (Pixel 7), pwa (build prod :8091)
├── global-setup.ts           # cria rs_e2e + migrations (reusa migrate-lib.ts) + seed companies
├── fixtures/
│   ├── index.ts              # test estendido (mergeTests)
│   ├── auth.ts               # loginAs(tipo) — register via API + addInitScript(rs_token)
│   ├── api.ts                # ApiClient: factories REST (cliente, produto, pedido, atividade, usuário…)
│   ├── db.ts                 # pool pg direto (asserts/seed pontual)
│   └── external-mocks.ts     # page.route p/ tiles OSM (PNG 1x1)
├── helpers/                  # swal.ts, kanban.ts (DnD), upload.ts (CSV inline)
├── seed/companies.sql        # ~200 empresas fake com geom PostGIS, CNAEs/UFs conhecidos
├── stub-server/index.ts      # HTTP stub: OSRM /trip, Nominatim, BrasilAPI, Evolution
├── COVERAGE.md               # checklist canônico de fluxos (critério de 100%)
└── tests/01-auth … 20-pwa-offline/
```

### `playwright.config.ts` (essência)

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /07-agenda|20-pwa/ },
    // pwa: baseURL http://localhost:8091 (build prod servido pelo Fastify), testMatch /20-pwa/
  ],
  // Sem webServer: a stack sobe via docker compose (ver Ambiente).
});
```

Browsers: **só Chromium** (app B2B; usuários de campo = Android/Chrome — mesmo engine). Firefox/WebKit agregam pouco frente ao custo.

## Ambiente

- **Banco dedicado `rs_e2e`** (nunca `rs` dev). `global-setup.ts` copia a lógica de `server/test/setup.ts`: cria DB, roda migrations, `TRUNCATE companies CASCADE` + aplica `seed/companies.sql`.
- **`docker-compose.e2e.yml`** (override): `app` com `DATABASE_URL=…/rs_e2e`, `JWT_SECRET=e2e-secret`, `AUTH_RATE_LIMIT_MAX=1000000`, URLs externas apontando ao stub; publica porta do db p/ o host; desabilita `evolution`, `evolution_db` (profiles); adiciona serviços `mailpit` (axllent/mailpit) e `stub` (stub-server).
- **Isolamento**: org nova por teste via `register` com email único (`e2e.<ts>.<rand>@teste.com`) — multi-tenancy isola; sem truncate entre testes; `fullyParallel: true`. `companies` é read-only global.
- **Playwright no host**: `npx playwright install chromium --with-deps` uma vez; testes atacam `localhost:5173` (baseURL por env — permite container/CI com `E2E_BASE_URL=http://web:5173`).
- **Seed companies**: ~200 empresas em 3-4 municípios com `geom` (`ST_MakePoint`), CNAEs/portes variados, situação ativa; inclui cluster denso (agrupamento no mapa) e bordas (sem geom, baixada).

## Única mudança em código de produção

Extrair URLs externas para env com default atual (comportamento inalterado sem env):

- `server/src/geocode.ts`: `NOMINATIM_URL`, `BRASILAPI_URL`
- `server/src/routes/routes.ts`: `OSRM_URL`

## Fixtures-chave

```ts
// fixtures/auth.ts — auth programático; UI de login testada só na suíte 01-auth
loginAs: async ({ page, request }, use) => {
  await use(async (tipo = 'escritorio') => {
    const email = `e2e.${Date.now()}.${Math.random().toString(36).slice(2)}@teste.com`;
    const r = await request.post('/api/auth/register', {
      data: { org_nome: 'Org e2e', email, senha: 'senha123', tipo_conta: tipo },
    });
    expect(r.status()).toBe(201);
    const s = await r.json();
    await page.addInitScript(t => localStorage.setItem('rs_token', t), s.token);
    return s;
  });
}
```

- Regra de ouro: **arrange por API, act/assert pela UI**. Ex.: teste de "editar pedido" cria o pedido via `ApiClient` e testa só a edição na tela.
- `ApiClient(request, token)` espelha `server/test/helpers.ts`: `createCliente()`, `createProduto()`, `createPedido()`, `createAtividade()`, `createUsuario(grupo)`, `createTransportadora()`, `createLancamento()`…
- **Sem page objects clássicos** — helpers funcionais (`swal.ts`, `openRow()`, `fillModal()`). Exceção: `KanbanPage` e `WhatsAppPage` (estado complexo WS/DnD).
- **Sem `storageState` compartilhado** (contraria org-por-teste).

## Dependências externas

| Dependência | Chamada de | Estratégia |
|---|---|---|
| Tiles OSM | browser (Leaflet) | `page.route('https://*.tile.openstreetmap.org/**')` → PNG 1x1 (fixture auto) |
| Nominatim / BrasilAPI | server (`geocode.ts`) | env → stub local (coords fixas por CEP/endereço do seed) |
| OSRM | server (`routes.ts`) | env → stub `/trip` com `{code:'Ok', trips, waypoints}` e ordem determinística |
| Evolution/WhatsApp | server | `EVOLUTION_API_URL` → stub (create instance, QR base64 fake, send 200); recebimento via `POST /api/webhooks/whatsapp` real |
| SMTP | server (nodemailer) | Mailpit no compose (SMTP :1025, API :8025); assert via `GET /api/v1/messages` |

`stub-server/index.ts` = um Node HTTP server (~150 linhas), serviço no compose e2e (funciona igual em CI).

## Matriz de cobertura (fases)

### Fase 1 — Auth + smoke (~15 testes)

- `01-auth/login.spec.ts`: login ok; senha errada; logout; redirect `/*` → `/login` sem token; token inválido → login.
- `01-auth/register.spec.ts`: cadastro individual (menu sem Equipe/Grupos/Carteiras); escritório (menu completo); email duplicado (409); validações.
- `01-auth/trocar-senha.spec.ts`: `must_change_password` (user criado por admin via API) → qualquer rota redireciona `/trocar-senha`; troca libera.
- `02-smoke/navegacao.spec.ts`: visita as 21 rotas assertando heading + zero `pageerror` + zero 5xx. Garante "toda rota renderiza".

### Fase 2 — CRUDs núcleo (~45 testes)

- `03-clientes/`: CRUD modal, busca/filtro, import CSV (upload ok + linhas inválidas reportadas), descarte com motivo, vínculo a empresa do seed.
- `06-catalogo/`: CRUD produto; tabela de preço (criar, preços, aplicar a cliente); produto inativo some do pedido novo.
- `05-pedidos/`: criar (cliente+itens+tabela, totais/IPI/ST), editar, transições de status (válida; inválida bloqueada), import, impressão, cancelar (SweetAlert).
- `04-funil/`: colunas = 7 etapas default; card via API aparece na etapa certa; **drag entre colunas persiste** (reload confirma); ganho/perdido pede motivo.
- `07-agenda/`: criar atividade, check-in (`context.grantPermissions` + `setGeolocation`), relato, concluir; visão dia/semana.
- `08-financeiro/`: lançamento receita/despesa, baixa, recorrência gera filhos, fluxo de caixa e DRE batem (valores redondos semeados por API).
- `09-comissoes/`: regra → pedido faturado gera comissão → baixa → conciliação.
- `12-transportadoras/`: CRUD + uso no pedido.

### Fase 3 — Fluxos complexos (~25 testes)

- `10-prospeccao/`: busca CNAE/UF/porte retorna seed; `.leaflet-marker-icon` count; "adicionar ao funil" cria relationship; filtro exclui já-clientes.
- `11-rotas/`: rota 3+ paradas (clientes com geom via API) → otimizar (stub OSRM) → ordem exibida = stub; custo combustível; limite 25 paradas.
- `14-whatsapp/`: conectar (QR fake renderiza); enviar (stub confirma POST); **receber: webhook → mensagem aparece via WS sem reload**; mídia.
- `13-email/`: template CRUD; agendar; disparo assertado no Mailpit.
- `20-pwa-offline/` (projeto `pwa`, **build de produção** servido pelo Fastify :8091 — Vite dev não tem SW): `navigator.serviceWorker.ready` → `context.setOffline(true)` → agenda do dia renderiza (SW NetworkFirst) → check-in enfileira (IndexedDB, `lib/offline.ts`) → online → fila sincroniza (assert via API).

### Fase 4 — RBAC + relatórios + conta (~30 testes)

- `19-rbac/matrix.spec.ts`: parametrizado — grupos default (Vendedor/Gerente/Financeiro) × 15 codes: item ausente do menu + navegação direta redireciona `/` + request manual 403. Codes de `App.tsx`: `prospeccao.view`, `relationships.list`, `orders.list`, `whatsapp.view`, `commissions.list`, `reports.sales`, `carriers.list`, `routes.list`, `catalog.list`, `activities.list`, `email_schedules.list`, `finance.list`, `users.list`, `groups.list`, `carteiras.view`.
- `19-rbac/individual.spec.ts`: conta individual → `/equipe`, `/grupos`, `/carteiras` redirecionam (`RequireOffice`).
- `15-equipe-grupos/`: CRUD usuário (novo user loga), desativar bloqueia login, grupo custom com toggles refletindo no menu do membro.
- `16-carteiras/`: transferência muda dono dos clientes; visibilidade escopada.
- `17-relatorios/`: massa por API com valores fixos → vendas por período bate soma; ABC classifica; cobertura; descartes; mapa renderiza.
- `18-config-conta/`: SMTP (Mailpit) salvar+testar; alíquotas refletem no pedido; perfil; **upgrade individual→escritório** em `/conta` exibe menus office.
- `02-smoke/dashboard.spec.ts`: KPIs batem com massa criada; meta reflete no gauge.

### Fase 5 — CI (GitHub Actions)

`.github/workflows/e2e.yml`: checkout → `docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --wait` → `npm ci` em `e2e/` → `npx playwright install chromium --with-deps` → `npx playwright test --project=chromium` → upload `playwright-report/` + traces. PR roda subset `@core` (`--grep`); suíte completa em push na main + nightly (schedule). `workers: 2`, `retries: 2`. Suíte completa ≈ 15-25 min.

## Táticas para casos difíceis

- **Kanban HTML5 DnD**: tentar `dragTo()` primeiro (Playwright suporta HTML5 dnd em Chromium); fallback `page.dispatchEvent('dragstart'/'dragover'/'drop')` com `DataTransfer`. Sempre reload após drop p/ confirmar persistência.
- **Leaflet**: assert por DOM (`.leaflet-marker-icon` count, `.leaflet-popup-content`, efeitos no painel lateral), nunca pixel. Tiles mockados = load instantâneo. Se precisar clicar em marcador específico, adicionar `data-*` nos markers.
- **SweetAlert2**: DOM normal — `page.locator('.swal2-confirm').click()`; asserts em `.swal2-title`/`.swal2-html-container`.
- **Upload**: `setInputFiles({ name: 'clientes.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })` — CSV inline, sem fixture binária.
- **Impressão/PDF**: stub `window.print` via `addInitScript` (flag `__printed`) + assert do layout de impressão no DOM.
- **WebSocket WhatsApp**: não mockar (é do app); estimular pela ponta real via webhook e assertar chat atualizado sem reload.
- **PWA/offline**: `setOffline(true)` corta rede mas SW continua ativo — cenário alvo exato. Rodar contra build prod (dev Vite tem `devOptions.enabled: false`).

## Critério de "100%" (mensurável)

`e2e/COVERAGE.md` versionado:

1. **21/21 rotas** com smoke (renderiza sem erro de console) — automático via `02-smoke`.
2. **~85 fluxos canônicos** (cenários da matriz), cada um mapeado a um `test()` nomeado igual. 100% = todos verdes.
3. **Guards**: 15 codes × (menu oculto + redirect + 403) + 3 rotas office-only × conta individual.
4. Regra de manutenção: PR que adiciona rota/feature adiciona linha no COVERAGE.md. Acompanhar com `npx playwright test --list` vs checklist.

## Scripts

```json
// e2e/package.json
{
  "scripts": {
    "stack:up": "docker compose -f ../docker-compose.yml -f ../docker-compose.e2e.yml up -d --wait db app web mailpit stub",
    "stack:down": "docker compose -f ../docker-compose.yml -f ../docker-compose.e2e.yml down",
    "test": "playwright test",
    "test:ui": "playwright test --ui",
    "test:pwa": "playwright test --project=pwa",
    "report": "playwright show-report"
  }
}
```

## Ordem e estimativa (1 pessoa)

| Fase | Conteúdo | Esforço | Entregável |
|---|---|---|---|
| 0 | Infra: workspace e2e, compose override, envs URL no server, stub, Mailpit, global-setup, seed, fixtures | 2-3 dias | teste dummy verde |
| 1 | Auth + smoke 21 rotas | 1-2 dias | ~15 testes |
| 2 | CRUDs núcleo (spike DnD 1 dia no início) | 5-7 dias | ~45 testes |
| 3 | Complexos (spike SW/offline meio dia no início) | 4-6 dias | ~25 testes |
| 4 | RBAC matrix + relatórios + conta | 3-4 dias | ~30 testes |
| 5 | CI + COVERAGE.md fechado + estabilização | 1-2 dias | pipeline verde |

**Total ~16-24 dias úteis, ~115-130 testes.** Riscos principais: DnD do Kanban e PWA/SW — mitigados com spikes no início das fases 2 e 3. Sequência estrita: Fase 0 destrava tudo; fixtures de auth/API são reutilizadas por 100% dos specs.

## Verificação

- Fase 0 pronta quando: `npm run stack:up && npm test` roda 1 teste dummy verde contra `rs_e2e` com stub/Mailpit no ar.
- Cada fase fecha com suíte inteira verde 3 execuções seguidas (`--repeat-each` nos specs novos p/ detectar flake).
- Fase final: pipeline CI verde + COVERAGE.md sem pendências.

## Arquivos críticos (referência de implementação)

- `server/test/helpers.ts`, `server/test/setup.ts` — padrões a espelhar
- `server/scripts/migrate-lib.ts` — runner reutilizado pelo global-setup
- `client/src/App.tsx` — rotas/guards/codes (fonte da matriz RBAC)
- `client/src/lib/api.ts` — chave `rs_token`
- `server/src/geocode.ts`, `server/src/routes/routes.ts` — únicas mudanças de produção (URLs → env)
- `docker-compose.yml` — base do override e2e

---

## Checklist Completo de Testes (Especificação)

Enumeração de todo `test()` planejado, organizado por spec file. Este é o conteúdo real de `e2e/COVERAGE.md` — cada linha é um teste que deve existir e passar para a suíte ser considerada completa.

**Total: 206 testes** (revisa para cima a estimativa inicial de ~115-130 do plano original — a contagem grosseira por fase virou enumeração individual de guard/edge case, e foi adicionada uma suíte de isolamento multi-tenant que não estava na matriz original).

| Diretório | Arquivos | Testes |
|---|---|---|
| `01-auth/` | 3 | 19 |
| `02-smoke/` | 3 | 28 |
| `03-clientes/` | 3 | 11 |
| `04-funil/` | 2 | 9 |
| `05-pedidos/` | 4 | 11 |
| `06-catalogo/` | 3 | 8 |
| `07-agenda/` | 3 | 8 |
| `08-financeiro/` | 4 | 8 |
| `09-comissoes/` | 1 | 5 |
| `10-prospeccao/` | 4 | 11 |
| `11-rotas/` | 2 | 9 |
| `12-transportadoras/` | 1 | 5 |
| `13-email/` | 3 | 8 |
| `14-whatsapp/` | 3 | 10 |
| `15-equipe-grupos/` | 2 | 9 |
| `16-carteiras/` | 1 | 4 |
| `17-relatorios/` | 1 | 6 |
| `18-config-conta/` | 2 | 8 |
| `19-rbac/` | 3 | 19 |
| `20-pwa-offline/` | 1 | 6 |
| `21-isolamento/` (novo, cross-cutting) | 1 | 4 |
| **Total** | **50** | **206** |

### 01-auth/

**`login.spec.ts`**
- [ ] login com credenciais válidas redireciona para o dashboard
- [ ] login com senha incorreta mostra erro e permanece em `/login`
- [ ] login com email inexistente mostra erro genérico (não revela se o email existe)
- [ ] logout limpa o token e redireciona para `/login`
- [ ] acessar rota protegida sem token redireciona para `/login`
- [ ] token inválido/expirado no localStorage redireciona para `/login`
- [ ] usuário desativado não consegue logar (403)

**`register.spec.ts`**
- [ ] cadastro tipo individual cria conta e o menu não mostra Equipe/Grupos/Carteiras
- [ ] cadastro tipo escritório cria conta e o menu mostra todos os itens (usuário admin)
- [ ] cadastro com email já usado retorna 409 e mensagem é exibida
- [ ] cadastro com senha menor que 6 caracteres mostra validação
- [ ] cadastro sem preencher campos obrigatórios mostra validação
- [ ] após cadastro, o funil nasce com as 7 etapas padrão
- [ ] após cadastro, os grupos RBAC padrão existem (Administrador/Vendedor/Gerente/Financeiro) em `/grupos`

**`trocar-senha.spec.ts`**
- [ ] usuário com `must_change_password` é redirecionado para `/trocar-senha` a partir de qualquer rota
- [ ] usuário com `must_change_password` não consegue navegar para outra rota via URL direta
- [ ] trocar senha com sucesso libera a navegação normal
- [ ] trocar senha com senha atual incorreta mostra erro
- [ ] campos de confirmação de senha divergentes bloqueiam o submit

### 02-smoke/

**`navegacao.spec.ts`** — uma verificação por rota (heading correto + zero `pageerror` + zero resposta 5xx):
- [ ] `/login`
- [ ] `/` (Dashboard)
- [ ] `/prospeccao`
- [ ] `/funil`
- [ ] `/clientes`
- [ ] `/carteiras`
- [ ] `/pedidos`
- [ ] `/whatsapp`
- [ ] `/email`
- [ ] `/agenda`
- [ ] `/transportadoras`
- [ ] `/rotas`
- [ ] `/catalogo`
- [ ] `/comissoes`
- [ ] `/financeiro`
- [ ] `/relatorios`
- [ ] `/equipe`
- [ ] `/grupos`
- [ ] `/config`
- [ ] `/conta`
- [ ] `/trocar-senha`

**`dashboard.spec.ts`**
- [ ] KPIs do dashboard batem com massa de pedidos/clientes semeada via API
- [ ] definir meta de vendas reflete no gauge/indicador de progresso
- [ ] dashboard de org recém-criada (sem dados) mostra estado vazio tratado, sem erro

**`notificacoes.spec.ts`**
- [ ] sino de notificações lista pendências (vencimento/agenda/comissão/parado)
- [ ] marcar notificação individual como lida remove do contador
- [ ] "marcar todas como lidas" zera o contador
- [ ] poll de notificações atualiza a lista sem reload da página

### 03-clientes/

**`crud.spec.ts`**
- [ ] criar cliente manualmente via modal (vínculo a empresa do seed) aparece na lista
- [ ] editar cliente existente persiste as alterações
- [ ] excluir/desativar cliente remove da lista ativa
- [ ] buscar cliente por nome/CNPJ filtra a lista
- [ ] filtrar por etapa do funil filtra a lista
- [ ] descartar cliente exige motivo (SweetAlert) e move para descartados
- [ ] reverter descarte retorna o cliente à lista ativa

**`import.spec.ts`**
- [ ] importar CSV válido cria múltiplos clientes
- [ ] importar CSV com linhas inválidas reporta os erros por linha e não cria as inválidas
- [ ] importar CSV com CNPJ duplicado é rejeitado/ignorado com aviso

**`guard.spec.ts`**
- [ ] usuário sem `relationships.list` não vê `/clientes` no menu e é redirecionado ao acessar via URL

### 04-funil/

**`kanban.spec.ts`**
- [ ] kanban carrega as 7 etapas padrão como colunas
- [ ] card criado via API aparece na coluna/etapa correta
- [ ] arrastar card para outra coluna atualiza a etapa imediatamente
- [ ] etapa do card persiste após reload da página
- [ ] mover card para etapa "ganho" completa o fluxo esperado
- [ ] mover card para etapa "perdido" exige motivo via modal/SweetAlert
- [ ] abrir card mostra os detalhes do cliente/empresa
- [ ] usuário sem `relationships.update` não consegue arrastar (card não é `draggable`)

**`guard.spec.ts`**
- [ ] usuário sem `relationships.list` não vê `/funil` no menu e é redirecionado

### 05-pedidos/

**`crud.spec.ts`**
- [ ] criar pedido com cliente + itens da tabela de preço calcula os totais corretamente
- [ ] criar pedido calcula IPI/ST conforme as alíquotas configuradas
- [ ] editar pedido existente (itens/quantidades) recalcula os totais
- [ ] cancelar pedido exige confirmação (SweetAlert) e muda o status
- [ ] excluir pedido em rascunho remove da lista

**`transicoes.spec.ts`**
- [ ] transição de status válida (rascunho→enviado→faturado) é permitida
- [ ] transição de status inválida (pular etapa) é bloqueada com mensagem
- [ ] pedido faturado gera lançamento de comissão correspondente

**`import-impressao.spec.ts`**
- [ ] importar pedidos via CSV cria os registros
- [ ] imprimir pedido aciona `window.print` com o layout de impressão correto

**`guard.spec.ts`**
- [ ] usuário sem `orders.list` não vê `/pedidos` e é redirecionado

### 06-catalogo/

**`produtos.spec.ts`**
- [ ] criar produto aparece na lista do catálogo
- [ ] editar produto persiste as alterações
- [ ] inativar produto não aparece mais como opção em novo pedido
- [ ] produto inativo continua visível em pedidos antigos (histórico preservado)

**`tabelas-preco.spec.ts`**
- [ ] criar tabela de preço e associar preços a produtos
- [ ] aplicar tabela de preço a um cliente reflete no pedido criado para esse cliente
- [ ] tabela de preço marcada como ativa é a usada por padrão em novo pedido

**`guard.spec.ts`**
- [ ] usuário sem `catalog.list` não vê `/catalogo` e é redirecionado

### 07-agenda/

**`atividades.spec.ts`**
- [ ] criar atividade/compromisso aparece na visão do dia
- [ ] editar atividade persiste as alterações
- [ ] concluir atividade muda o status
- [ ] visão de semana lista as atividades da semana corretamente

**`checkin.spec.ts`**
- [ ] check-in com geolocalização concedida registra local e horário
- [ ] check-in sem permissão de geolocalização mostra fallback/erro tratado
- [ ] relatar visita após check-in salva o relato vinculado à atividade

**`guard.spec.ts`**
- [ ] usuário sem `activities.list` não vê `/agenda` e é redirecionado

### 08-financeiro/

**`lancamentos.spec.ts`**
- [ ] criar lançamento de receita aparece no fluxo de caixa
- [ ] criar lançamento de despesa aparece no fluxo de caixa
- [ ] dar baixa em lançamento muda o status para pago/quitado
- [ ] editar/excluir lançamento pendente

**`recorrencia.spec.ts`**
- [ ] criar lançamento recorrente e rodar a geração cria os filhos esperados (quantidade e datas corretas)

**`relatorios-financeiros.spec.ts`**
- [ ] fluxo de caixa soma receitas e despesas semeadas corretamente por período
- [ ] DRE calcula o resultado esperado com os dados semeados

**`guard.spec.ts`**
- [ ] usuário sem `finance.list` não vê `/financeiro` e é redirecionado

### 09-comissoes/

**`comissoes.spec.ts`**
- [ ] criar regra de comissão (percentual/faixa)
- [ ] pedido faturado gera comissão conforme a regra aplicável
- [ ] dar baixa em comissão muda o status para pago
- [ ] conciliar comissões com lançamentos financeiros bate os valores
- [ ] usuário sem `commissions.list` não vê `/comissoes` e é redirecionado

### 10-prospeccao/

**`busca.spec.ts`**
- [ ] busca por CNAE retorna empresas do seed compatíveis
- [ ] busca por UF/município filtra corretamente
- [ ] busca por porte filtra corretamente
- [ ] filtro exclui empresas já vinculadas como cliente
- [ ] resultado vazio mostra estado vazio tratado

**`mapa.spec.ts`**
- [ ] mapa renderiza marcadores para os resultados (`.leaflet-marker-icon` count)
- [ ] clicar em marcador abre popup com os dados da empresa
- [ ] cluster geográfico denso do seed agrupa marcadores corretamente

**`acao.spec.ts`**
- [ ] "adicionar ao funil" a partir do resultado cria relationship na primeira etapa
- [ ] empresa sem geocode válido não aparece no mapa mas aparece na lista

**`guard.spec.ts`**
- [ ] usuário sem `prospeccao.view` não vê `/prospeccao` e é redirecionado

### 11-rotas/

**`planejamento.spec.ts`**
- [ ] montar rota com 3+ paradas (clientes com geom via API)
- [ ] otimizar rota (stub OSRM) reordena as paradas conforme a resposta determinística do stub
- [ ] custo estimado de combustível é calculado e exibido
- [ ] adicionar mais de 25 paradas é bloqueado com aviso
- [ ] salvar rota e reabri-la mantém ordem e paradas
- [ ] reutilizar rota anterior copia as paradas para a nova rota
- [ ] registrar despesa de rota (pedágio/combustível) associa ao histórico
- [ ] visão de agenda da rota mostra as paradas do dia

**`guard.spec.ts`**
- [ ] usuário sem `routes.list` não vê `/rotas` e é redirecionado

### 12-transportadoras/

**`crud.spec.ts`**
- [ ] criar transportadora aparece na lista
- [ ] editar transportadora persiste as alterações
- [ ] excluir/inativar transportadora
- [ ] transportadora aparece como opção ao criar pedido
- [ ] usuário sem `carriers.list` não vê `/transportadoras` e é redirecionado

### 13-email/

**`templates.spec.ts`**
- [ ] criar template de email
- [ ] editar template persiste as alterações
- [ ] excluir template

**`agendamento.spec.ts`**
- [ ] agendar envio de email para data/hora futura
- [ ] cancelar email agendado antes do disparo
- [ ] email agendado dispara e chega no Mailpit com o conteúdo do template
- [ ] falha de envio (SMTP mal configurado) é reportada na UI

**`guard.spec.ts`**
- [ ] usuário sem `email_schedules.list` não vê `/email` e é redirecionado

### 14-whatsapp/

**`conexao.spec.ts`**
- [ ] iniciar conexão gera QR code (stub) exibido na tela
- [ ] status de conexão atualiza para "conectado" (stub)
- [ ] desconectar instância atualiza o status

**`mensagens.spec.ts`**
- [ ] enviar mensagem de texto para um chat (stub confirma o POST)
- [ ] enviar mídia (imagem/arquivo) via upload
- [ ] receber mensagem via webhook aparece no chat em tempo real via WebSocket, sem reload
- [ ] marcar mensagens como lidas
- [ ] merge de dois chats do mesmo contato une o histórico
- [ ] agendar envio de mensagem para depois

**`guard.spec.ts`**
- [ ] usuário sem `whatsapp.view` não vê `/whatsapp` e é redirecionado

### 15-equipe-grupos/

**`equipe.spec.ts`**
- [ ] criar usuário novo (via `/equipe`) e ele consegue logar
- [ ] editar dados do usuário persiste as alterações
- [ ] desativar usuário bloqueia login subsequente
- [ ] resetar senha de usuário gera senha provisória (`must_change_password`)
- [ ] usuário sem `users.list` não vê `/equipe` e é redirecionado; conta individual também bloqueia (`RequireOffice`)

**`grupos.spec.ts`**
- [ ] criar grupo customizado com subconjunto de permissões
- [ ] editar permissões do grupo reflete no menu de um membro (login como esse membro)
- [ ] grupo "Administrador" não pode ser excluído/alterado (proteção)
- [ ] usuário sem `groups.list` não vê `/grupos` e é redirecionado; conta individual também bloqueia

### 16-carteiras/

**`carteiras.spec.ts`**
- [ ] listar carteiras por vendedor mostra os clientes corretos
- [ ] transferir carteira de um vendedor para outro move os clientes
- [ ] vendedor vê apenas os clientes da própria carteira (escopo); gerente/admin vê todas
- [ ] conta individual não acessa `/carteiras` (`RequireOffice`); conta escritório sem `carteiras.view` também é redirecionada

### 17-relatorios/

**`relatorios.spec.ts`**
- [ ] relatório de vendas por período soma os valores dos pedidos semeados corretamente
- [ ] curva ABC classifica os clientes conforme os valores semeados (A/B/C)
- [ ] relatório de cobertura territorial mostra municípios/regiões visitadas vs. não visitadas
- [ ] relatório de descartes lista os clientes descartados com motivo
- [ ] mapa do relatório de cobertura renderiza marcadores/áreas
- [ ] usuário sem `reports.sales` não vê `/relatorios` e é redirecionado

### 18-config-conta/

**`config.spec.ts`**
- [ ] configurar SMTP e salvar persiste
- [ ] testar SMTP configurado envia email de teste (assert no Mailpit)
- [ ] configurar alíquotas (IPI/ST) reflete no cálculo de novo pedido

**`conta.spec.ts`**
- [ ] editar perfil da organização persiste as alterações
- [ ] visualizar origem geográfica da organização
- [ ] trocar senha a partir de `/conta` (fluxo voluntário, distinto do forçado)
- [ ] upgrade de conta individual para escritório: menus Equipe/Grupos/Carteiras passam a aparecer
- [ ] após upgrade, os grupos RBAC padrão ficam visíveis em `/grupos`

### 19-rbac/

**`matrix.spec.ts`** — parametrizado: para cada code abaixo, um usuário sem essa permissão deve ter (a) item de menu ausente, (b) navegação direta pela URL redirecionada para `/`, e (c) chamada de API correspondente retornando 403:
- [ ] `prospeccao.view`
- [ ] `relationships.list`
- [ ] `orders.list`
- [ ] `whatsapp.view`
- [ ] `commissions.list`
- [ ] `reports.sales`
- [ ] `carriers.list`
- [ ] `routes.list`
- [ ] `catalog.list`
- [ ] `activities.list`
- [ ] `email_schedules.list`
- [ ] `finance.list`
- [ ] `users.list`
- [ ] `groups.list`
- [ ] `carteiras.view`

**`individual.spec.ts`**
- [ ] conta individual acessando `/equipe` via URL é redirecionada
- [ ] conta individual acessando `/grupos` via URL é redirecionada
- [ ] conta individual acessando `/carteiras` via URL é redirecionada

**`admin-bypass.spec.ts`**
- [ ] usuário admin (`is_admin`) acessa todas as rotas independente do grupo

### 20-pwa-offline/

**`offline.spec.ts`** (projeto `pwa`, build de produção)
- [ ] service worker registra e fica `ready` no build de produção
- [ ] agenda do dia carregada online continua acessível após ficar offline (cache NetworkFirst)
- [ ] check-in feito offline é enfileirado localmente (IndexedDB)
- [ ] ao voltar online, a fila sincroniza automaticamente e o servidor recebe o check-in
- [ ] indicador visual de "offline"/"pendente de sincronização" aparece na UI durante o período offline
- [ ] rota `/rotas` tem cache NetworkFirst equivalente e funciona offline

### 21-isolamento/ (novo — multi-tenant, cross-cutting)

**`multi-tenant.spec.ts`**
- [ ] usuário da Org A não vê clientes da Org B em `/clientes`
- [ ] usuário da Org A não consegue acessar pedido da Org B via ID direto na API (403/404)
- [ ] usuário da Org A não vê mensagens de WhatsApp da Org B
- [ ] busca em `/prospeccao` não vaza relationships da Org B como "já cliente"
