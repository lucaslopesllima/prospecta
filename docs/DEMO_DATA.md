# Base de demonstração

**Status: implementada.** `server/scripts/seed-demo.ts` (+ `seed-demo-data.ts`
com o conteúdo curado e `seed-demo-assets.ts` com a mídia gerada), migrações
`072_org_demo.sql` e `073_company_source_demo.sql`, guards de demo em
`src/demo.ts` / `routes/whatsapp.ts` / `whatsappScheduler.ts`, testes em
`test/routes-whatsapp-demo.test.ts` e `test/companies-demo-source.test.ts`.

```bash
docker compose exec app node scripts/seed-demo.ts --reset
```

O que segue é a estratégia e, ao longo do texto, as **correções** que a
implementação impôs ao plano original (marcadas como tal — vale ler antes de
repetir o raciocínio antigo).

Objetivo: uma org fictícia com 6 meses de operação "em regime", de modo que
**toda tela** do app tenha conteúdo plausível (dashboard com série temporal,
funil em movimento, pedidos faturados, comissões previstas/recebidas, agenda
com passado e futuro, rotas rodadas, financeiro com contas em aberto, WhatsApp
com histórico). Nada de tela vazia, nada de dado obviamente sintético
("Empresa 001", "Produto A").

Persona: **representação comercial do ramo alimentício** — escritório que
representa indústrias de alimentos e vende para varejo (supermercados,
mini-mercados, padarias) e food service (restaurantes, lanchonetes), com
distribuidores/atacados no meio.

---

## 1. Onde a base de demo vive

Três opções; a recomendada é a (A).

| | Como | Prós | Contras |
|---|---|---|---|
| **A. Org de demo dentro do banco real** (recomendado) | `organizations` nova, tudo escopado por `org_id` | Prospecção/mapa/recomendação usam o pool real de 28M empresas da RFB — que é justamente o diferencial do produto | Precisa de reset periódico e de cuidado com empresas fictícias no pool global (ver §3) |
| B. Banco `rs_demo` separado | Stack própria (compose separado) | Isolamento total; visitante pode até quebrar | Pool global (`companies` 28M + `company_geocode` 26M) teria que ser copiado ou reduzido → recomendação/mapa ficam pobres |
| C. Só em dev, para screenshots | Roda o seed no `rs` local | Zero risco em produção | Não serve para demo ao vivo / trial |

Decisão prática: **A em produção** (org `Sabor & Cia Representações`) e o
**mesmo script** rodando em dev para screenshots e material de marca.

Regra de ouro do seed: só escreve em tabelas **tenant** (com `org_id`) e em
`companies`/`company_geocode` sob a marcação de demo da §3. Nunca toca em
`municipios`, `cnae_reference`, `socios`, `rfb_*`.

---

## 2. Chaves da modelagem que o seed precisa respeitar

Descobertas do schema que ditam a ordem e a forma de inserir:

- `companies` é **pool global**, nunca é do tenant. O vínculo do tenant é
  `company_relationships (org_id, company_id)` — é lá que mora funil
  (`stage_id`), status (`prospect|cliente|descartado`), dono e valor.
- `orders.numero` é sequencial por org → gerar em ordem crescente junto com
  `created_at`/`faturado_em` (número baixo = pedido antigo).
- **Comissão não se insere na mão.** `createCommissionForOrder()`
  (`server/src/commissions.ts`) resolve a regra vigente por item com
  precedência produto > cliente > vendedor > geral. O seed cria
  `commission_rules` e chama essa função para cada pedido faturado — assim a
  tela de Comissões mostra números coerentes com as regras exibidas.
- Org nova já nasce com **stages padrão** (`auth.ts`) e **grupos de permissão
  padrão** (`ensureDefaultGroups`). O seed deve reaproveitar, não duplicar.
- `/api/recommend` só devolve candidatos de UF/região presente em
  `enabled_regions` — em produção o ETL liga isso; em dev o seed precisa ligar.
  **Correção:** `enabled_regions` é uma tabela **global** (não tem `org_id`), e
  em dev já vem com as 27 UFs. O seed só garante `SP` com `ON CONFLICT DO
  NOTHING` — é a única escrita fora do tenant além de `companies`.
- ~~`target_profiles` (CNAEs alvo + territórios) é o que faz a tela Recomendação
  e o mapa produzirem resultado. Sem ela, tela vazia.~~ **Correção:** a tabela
  foi removida na migração `047_drop_target_profiles.sql`. Hoje território e
  CNAEs-alvo vêm do filtro da própria tela (`?munis=&cnae=`), então não há nada
  a semear: a Recomendação funciona na org de demo assim que existe uma UF
  habilitada, buscando no pool real.
- **Schedulers**: `email.ts` e `whatsappScheduler.ts` varrem `status='pendente'
  AND agendado_para <= now()` a cada minuto. Sem SMTP ativo eles apenas travam
  (não disparam nada). Ainda assim, o seed **não deve** criar pendentes
  vencidos — passado entra como `enviado`, futuro como `pendente`. A org de
  demo fica sem SMTP ativo.
- **WhatsApp** exige tratamento próprio: a tela é bloqueada por
  `status !== 'conectado'` (`client/src/pages/WhatsApp.tsx:1480`) e o front
  revalida o estado real na Evolution. Não basta semear conversas — ver §10.

---

## 3. Empresas fictícias × pool real

Tensão: as telas de carteira/pedidos/rotas ficam melhores com nomes fictícios
("Supermercado Bom Preço", "Padaria Trigo Dourado") do que com CNPJs reais de
terceiros; mas prospecção só impressiona com o pool real.

Solução híbrida:

1. **185 empresas fictícias** inseridas em `companies` com CNPJ na faixa
   reservada `999*`, geom com jitter em municípios reais. São essas que viram
   clientes, pedidos, rotas e conversas.

   **Correção importante:** o prefixo `9` de `server/test/helpers.ts` e
   `e2e/seed/companies.sql` **colide** com CNPJ real — a base completa da RFB tem
   ~110 mil CNPJs começando com 9, e semear com ele estoura
   `companies_cnpj_key`. A convenção só funciona nas fixtures, onde o pool tem
   dezenas de linhas. `999*` é a faixa que a RFB nunca emitiu (zero linhas em 28
   milhões; o maior CNPJ da base começa com 98), e o seed **confere** isso antes
   de escrever (`checarFaixaCnpj`) em vez de confiar na observação.
2. **Recomendação/mapa de prospecção usam o pool real** — o visitante busca
   "padaria em Campinas" e vê o Brasil de verdade.
3. **Vazamento** — **resolvido.** Migração `073_company_source_demo.sql` adiciona
   `demo` ao enum `company_source`, e `source <> 'demo'` filtra as **três**
   superfícies de descoberta:

   | Ponto | Arquivo | Por quê |
   |---|---|---|
   | recomendação | `src/sql/recommend.ts` | não sugerir empresa fictícia a nenhum tenant |
   | busca de empresa | `src/routes/companies.ts` (`/companies/search`) | autopreenchimento de cadastro por nome/CNPJ |
   | mercado potencial | `src/routes/reports.ts` (`/reports/coverage`) | fictícia não é mercado endereçável |

   Leitura por id (`GET /api/companies/:id`) **continua liberada** — a tela de
   cliente da própria org de demo depende dela. O filtro é de descoberta, não de
   acesso. Coberto por `test/companies-demo-source.test.ts` (5 casos), cada um
   com o contraponto: a empresa `rfb` equivalente, no mesmo município e CNAE,
   tem que continuar aparecendo — senão o filtro estaria só quebrando a busca.

---

## 4. Ancoragem temporal

Todo o histórico é **relativo a `current_date`**, nunca datas fixas — assim a
base não "envelhece" e o dashboard do mês corrente nunca fica vazio.

- Janela: **M-5 … M+1** (6 meses fechados + mês corrente + agenda futura).
- Sazonalidade alimentícia: volume crescente, pico em M-1 (datas comemorativas),
  leve queda em M-3.
- Mês corrente: ~~~60% do faturamento do mês anterior~~ **proporcional aos dias
  já decorridos do mês.** **Correção:** uma fração fixa só fica plausível no meio
  do mês — como a base é ancorada em `current_date` e o reset roda todo dia,
  rodando no dia 3 os 60% pareceriam um mês recordista e no dia 28, um colapso de
  vendas. O seed escala a quantidade de pedidos do mês corrente pelo calendário.
- O **status do pedido sai da idade dele**, não do mês: pedido de ontem está em
  cotação ou saindo, pedido de três semanas atrás já foi entregue. É o que dá
  pipeline de verdade nos últimos dias (cotação/enviado acumulados) sem esvaziar
  o faturamento do mês.
- Metas do mês corrente saem do realizado **fechado de M-1**, nunca do parcial de
  M0: derivar do parcial faria a meta encolher junto com o mês e o medidor
  marcaria 100% todo dia. Só os **vendedores** têm cota — o dashboard soma todas
  as `goals` da competência, então meta de quem não vende (o gerente) entraria no
  denominador sem nunca ter realizado. Pelo mesmo motivo, as metas **por
  representada** ficam em meses fechados: no mês corrente elas somariam por cima
  da meta global.
- Agenda: passado com `status='feito'` e check-in real (lat/lon + `relatorio`),
  hoje com 3-5 compromissos, +14 dias pendentes, uma série recorrente semanal.
- Financeiro: contas vencidas em aberto (2-3), vencendo esta semana, liquidadas
  no passado, recorrentes (aluguel, combustível, telefone).

---

## 5. Camadas do seed (ordem de execução)

Cada camada só depende das anteriores.

~~O script roda tudo em **uma transação**.~~ **Correção:** não há transação
única, porque o seed **reusa** `createCommissionForOrder()` e
`materializeRecurrences()` — que falam com o pool, não com um client, e portanto
não veriam as linhas de uma transação aberta. Reusar o motor de comissão vale
mais que a transação (é o que garante que a tela de Comissões bate com as regras
que ela exibe), então no lugar dela: **qualquer erro no meio do caminho apaga a
org recém-criada**. O banco volta ao estado anterior de todo jeito, e é o mesmo
mecanismo que implementa o `--dry-run`.

```
1. org + users + grupos + enabled_regions + tax_defaults + smtp (desligado)
2. represented_companies + represented_brands
3. catalog_items (+ impostos) → price_tables → price_table_items
4. companies fictícias (+ geocode) → company_relationships (funil) → contacts
   → private_labels + vínculos (empresas e contatos)
5. vehicles + carriers
6. orders (+ order_items) em ordem cronológica → commission_rules antes →
   createCommissionForOrder() nos faturados
7. finance_categories → finance_entries (inclui as comissões liquidadas)
8. goals (metas por vendedor × mês)
9. activities (visitas/ligações/tarefas) → sample_requests
10. routes + route_stops (dias de rota passados, 1 template recorrente)
11. email_templates + email_schedules (enviados/futuros)
12. whatsapp_chats + whatsapp_messages + whatsapp_schedules (futuros)
13. notifications + audit_log (últimos 30 dias)
```

### Volumes

Números de uma execução real (`--seed 42`). Variam poucos por cento entre dias,
porque a janela do mês corrente e a idade dos pedidos acompanham `current_date`.

| Camada | Qtd | Observação |
|---|---|---|
| users | 5 | 1 login de demo (`adm@rovvatech.com.br`, admin) + 4 da equipe fictícia: gerente, 2 vendedores, financeiro (ver §7) |
| represented_companies | 7 | 6 ativas (laticínios, massas/panificação, congelados, bebidas, mercearia seca, descartáveis food service) + 1 inativa |
| represented_brands | 16 | 1-3 marcas por representada |
| catalog_items | 90 | 15 por representada ativa, UN/CX/FD/KG/PC, ICMS 18/12, ST em bebidas, IPI em descartáveis |
| private_labels | 4 | marca de terceiro para a qual a empresa trabalha; 3-6 empresas e os contatos delas por marca — ver §5.1 |
| price_tables / itens | 12 / 180 | "Padrão" + "Rede/Atacado" por representada ativa |
| companies fictícias | 185 | CNAEs 4711302, 4712100, 4721102, 4722901, 4724500, 5611201, 5611203, 4639701. **Correção:** sem empresa órfã — toda fictícia tem relacionamento, porque o filtro de descoberta (§3) tornaria as sobrando inalcançáveis por qualquer tela |
| company_relationships | 185 | 60% cliente, 30% prospect, 10% descartado; ~14 parados >30d; 10 sem dono |
| contacts | 254 | comprador, gerente de loja, proprietário + 1 por representada; ~14 contas de propósito sem contato |
| orders / order_items | ~327 / ~1800 | todos os 6 status; 3-8 itens; ticket R$ 1,5k–25k |
| commission_rules | 10 | 6 gerais (5-8% por representada) + produto + cliente + 2 por vendedor |
| commission_entries | ~260 | previstas (mês corrente), recebidas (competências fechadas), 1 divergente |
| finance_categories / entries | 12 / ~290 | receber (comissões liquidadas + bonificações) + pagar (6 modelos mensais materializados + variáveis + 3 vencidas em aberto) |
| goals | 30 | 2 vendedores × 6 meses + 2 × 3 representadas × 3 meses fechados |
| activities | ~248 | passadas feitas c/ check-in (~12% ficam pendentes de propósito), hoje, +14 dias, série semanal de 8 ocorrências |
| routes / stops | ~25 / ~195 | roteiros semanais por vendedor; 6-10 paradas; 1 template `semanal` |
| sample_requests | 25 | crítico no alimentício (degustação) |
| whatsapp_chats / messages | 18 / ~550 | 18 roteiros curados + histórico curto; ver §8 |
| whatsapp_schedules | 6 | 3 pendentes (1 recorrente c/ `serie_id`), 2 enviados, 1 com erro |
| email_templates / schedules | 4 / 29 | enviados no passado, 1 com erro, 6 pendentes no futuro |
| audit_log | 150 | alimenta a tela Logs |
| notifications | 0 | **Correção:** não são semeadas. `/api/notifications` **recalcula** os alertas a cada leitura e apaga o que não bate — semear geraria linhas que o primeiro acesso descartaria. Os alertas nascem sozinhos dos dados acima (conta vencida, agenda de hoje, comissão, negócio parado) |

### 5.1 Private label

Private label é **informação de cadastro**, não estrutura de produto: registra que
uma empresa do funil **trabalha para a marca X** — produz ou fornece sob a marca
de um terceiro. E os contatos salvos no cadastro daquela empresa podem ser
relacionados à mesma marca (quem responde pelo acordo).

O modelo da migração `067` já dá conta disso e **não precisou mudar**:

| | |
|---|---|
| a marca | `private_labels` (nome, descrição, cor) |
| quem trabalha para ela | `private_label_companies → companies` |
| quem responde por ela | `private_label_contacts → contacts` |

Contato vinculado é sempre contato **de uma das empresas vinculadas** — é o que a
frase "o contato salvo no cadastro da empresa" quer dizer; contato solto na marca
não teria a quem se referir. O schema não força isso (seria rígido demais para a
ordem em que a tela preenche), mas o seed respeita.

No seed: 4 marcas, cada uma com 3-6 empresas em fatias sem sobreposição (acordo de
private label costuma ter exclusividade, então uma empresa trabalha para no máximo
uma marca) e 1-2 contatos por empresa. Só distribuidora/atacado e supermercado
entram — quem tem escala de produção ou fornecimento. Padaria de esquina e
lanchonete ficam de fora, e é isso que mantém a private label sendo uma
**informação**, e não uma etiqueta que todo mundo tem.

### Geografia

Território único e coerente: **interior de SP** — Campinas, Piracicaba,
Limeira, Americana, Sumaré, Indaiatuba, Santa Bárbara d'Oeste. Escritório em
Campinas (origem das rotas). Isso deixa mapa, rotas e custo de combustível com
distâncias realistas (30-80 km por perna) em vez de pontos espalhados pelo país.

---

## 6. Cobertura tela a tela (checklist de aceite)

**Percorrido na base semeada** — todos os endpoints das telas abaixo respondem
200 com conteúdo. Duas notas de leitura da tabela: a série recorrente da Agenda
não usa `serie_id` (a coluna existe em `email_schedules`/`whatsapp_schedules`,
não em `activities`, migração `065`), então a recorrência da agenda é semeada
como ocorrências materializadas; e a Recomendação não depende de
`target_profiles`, removida na migração `047`.

| Tela | Tabelas | Critério de "cheia" |
|---|---|---|
| Dashboard | orders, goals, commission_entries, activities, company_relationships | Vendas do mês > 0, meta definida, funil com contagem por stage, ≥3 clientes parados, ranking de vendedores |
| Kanban | stages, company_relationships | Todos os stages com cards; valores estimados preenchidos |
| Clientes | company_relationships, companies, contacts, private_labels | Lista paginada, private labels da empresa, contatos vinculados |
| Carteiras | users × company_relationships.owner_user_id | 2 carteiras com dono + bucket "sem dono" com ~10 |
| Contatos | contacts | Contatos de empresa e de representada |
| Recomendação | enabled_regions, companies (pool real) | Busca por CNAE alimentício retorna candidatos com score |
| Representadas | represented_companies, represented_brands | 6 ativas, 1 inativa |
| Catálogo | catalog_items | ~90 itens com preço, unidade e impostos |
| Tabelas de preço | price_tables, price_table_items | 2 tabelas vigentes por representada, com desconto máx. |
| Pedidos | orders, order_items, carriers | Todos os status representados; ≥1 com NF e faturado_em |
| Comissões | commission_rules, commission_entries | Previstas, recebidas e 1 divergente; competências dos 6 meses |
| Financeiro | finance_entries, finance_categories | Vencidas, a vencer, liquidadas, recorrentes; DRE com grupos |
| Metas | goals | Metas por vendedor nos 6 meses + mês corrente |
| Agenda | activities | Passado feito com check-in, hoje, futuro, série recorrente |
| Rotas | routes, route_stops, vehicles | Rotas rodadas com custo calculado + 1 template recorrente |
| Transportadoras | carriers | 4 ativas, usadas em pedidos |
| Amostras | sample_requests | Solicitada / enviada / recebida |
| Private labels | private_labels + vínculos | 4 marcas, cada uma com 3-6 empresas que trabalham para ela e os contatos delas |
| E-mail agendado | email_templates, email_schedules | 4 templates; enviados no passado, pendentes no futuro |
| WhatsApp | whatsapp_chats, whatsapp_messages, whatsapp_schedules + modo demo (§8) | Abre sem QR/número conectado; 18 conversas, ~550 mensagens, 4 com não-lidas, mídia, notas internas, agendamentos futuros; envio funciona e não sai da máquina |
| Equipe / Grupos | users, permission_groups | 5 usuários em 4 grupos distintos (login de demo + 4 da operação) |
| Relatórios | orders, companies, municipios | Séries por mês, top clientes, mapa por município |
| Logs | audit_log | ~150 eventos dos últimos 30 dias, vários atores |
| Conta / Config | organizations, org_tax_defaults, org_smtp_settings | Dados do escritório, impostos padrão; SMTP **inativo** |

---

## 7. Mecânica de execução

Script único: `server/scripts/seed-demo.ts` (TS nativo do Node 24, mesmo padrão
de `scripts/migrate.ts`, reusa `src/db.ts` e `src/commissions.ts`).

```bash
# dev
docker compose exec app node scripts/seed-demo.ts --reset

# produção (VPS)
docker compose -f docker-compose.prod.yml exec app node scripts/seed-demo.ts --reset
```

Flags:

- `--reset` — apaga a org de demo e recria do zero (idempotente de verdade).
  Sem ela, o script **recusa** semear se a org já existir.
- `--org "Sabor & Cia"` — nome da org de demo.
- `--seed 42` — PRNG determinística (mesma base em todo ambiente; nada de
  `Math.random()` sem semente, senão screenshots divergem entre execuções).
- `--dry-run` — semeia, imprime as contagens e **desfaz**. **Correção:** o plano
  dizia "sem gravar"; o script grava e apaga em seguida, pelo mesmo caminho de
  limpeza do erro. Contar sem gravar exigiria duplicar em JS a aritmética do
  motor de comissão e do materializador de recorrências — as contagens saem de
  `count(*)` no banco justamente para serem o número que o app vai enxergar.

**Reset** = `DELETE FROM organizations WHERE id = $demo` (cascata cobre as tenant
tables) + `DELETE FROM companies WHERE source = 'demo'` **sem relacionamento**
(a FK `company_relationships → companies` não tem `ON DELETE`, então a ordem
importa e o predicado protege as fictícias de outra org de demo). Nada de
`TRUNCATE`, que em produção derrubaria orgs reais. Quando
`WHATSAPP_MEDIA_DIR` está setado, o diretório `<dir>/<orgId>` da mídia sai junto.

**Recusas antes de escrever** (falhar cedo custa uma mensagem; falhar no meio
custa a org inteira): org não-demo com o mesmo nome, org de demo já existente sem
`--reset`, `adm@rovvatech.com.br` preso em outra org (o e-mail é UNIQUE global),
`DEMO_PASSWORD` vazia/curta, e faixa de CNPJ `999*` ocupada.

**Determinismo**: PRNG com semente (mulberry32) + datas relativas; sem
`Math.random()` e sem `Date.now()` cru espalhados pelo gerador — todos os
timestamps derivam de `current_date` lido do banco. Os horários são gravados com
offset **fixo `-03:00`**: o container do app pode rodar em UTC, e gravar "09:00"
cru faria a agenda comercial aparecer às 6h para o usuário.

**Reset agendado — DESLIGADO por decisão (2026-07-27).** O plano previa cron
diário às 4h rodando `seed-demo.ts --reset`, e nada disso foi instalado na VPS:
não há crontab do root nem timer systemd. O reset é **manual, sob demanda**:

```bash
ssh root@82.112.244.77 'cd ~/rovva && \
  docker compose -f docker-compose.prod.yml exec -T app node scripts/seed-demo.ts --reset'
```

Consequência assumida: a demo é pública e o visitante entra como admin da própria
org, então a base **degrada com o uso** — pedido cancelado, cliente apagado,
conversa suja. Quem for demonstrar deve rodar o reset antes. Se um dia isso virar
incômodo, o cron está descrito em §10.7 — mas ligá-lo é decisão de quem opera, não
um conserto pendente.

### Usuário de login da demo

O login da demonstração é um **usuário à parte**, que não se confunde com a
equipe fictícia da operação:

| | Login de demo | Equipe fictícia (4 usuários) |
|---|---|---|
| E-mail | `adm@rovvatech.com.br` | `ricardo.matos@…`, `juliana.prado@…`, `marcos.tavares@…`, `carla.ferraz@…` (domínio da própria org fictícia) |
| Papel | `admin` (grupo Administrador) | gerente, 2 vendedores, financeiro |
| Senha | definida por `DEMO_PASSWORD` (env), nunca no repo | aleatória de 32 bytes, descartada — **não servem para login** |
| Dados atribuídos | 3 contas a pagar (ver abaixo) — nada além disso | donos das carteiras, pedidos, rotas, atividades, metas |

Por quê separado:

- **`role='admin'` vê tudo** (`server/src/scope.ts:21`) — o visitante entra e
  todas as telas aparecem cheias, sem depender de quem é dono do quê.
- A equipe fictícia continua sendo a que aparece em Carteiras, ranking do
  dashboard, metas e comissões — o visitante observa a operação, não vira um
  dos vendedores. Se o login fosse um dos vendedores, metade das telas viria
  filtrada pelo escopo dele.
- Reset e revogação ficam triviais: uma linha em `users`, um e-mail conhecido.

**Correção à regra "dono de nada":** o usuário de demo é dono de **3 contas a
pagar**, de propósito. `/api/notifications` é estritamente por dono
(`owner_user_id = userId`, sem bypass de admin), então sem nenhum registro no
nome dele o sino da demo fica permanentemente vazio — por mais cheio que esteja
o dashboard. Conta a vencer é a âncora certa porque o alerta dispara o dia
inteiro (vencimento entre hoje e amanhã), diferente do de agenda, que só vale na
hora seguinte ao compromisso. E `finance_entries` não entra em Carteiras, ranking
de vendas, metas nem comissões — exatamente o que a regra existe para proteger.

Detalhes de implementação:

- `email` é UNIQUE global em `users` — `adm@rovvatech.com.br` está livre hoje;
  o `--reset` apaga a org de demo em cascata, então o e-mail é reutilizável.
- Senha via `hashPassword()` (scrypt, `server/src/auth.ts`), mínimo 6 chars
  (`auth.ts:31`). Vem de `DEMO_PASSWORD` no `.env` da VPS; o script falha se a
  var estiver vazia em produção (em dev, default `demo123`).
- ~~Se a demo for **pública**, trocar o grupo Administrador por um grupo "Demo"
  = preset Gerente sem `*.delete`, `settings.write` e `users.write`, mantendo
  `role='admin'` para a visão global e bloqueando os botões destrutivos via
  `can()`.~~ **Correção: isso não funciona.** `is_admin` faz bypass do RBAC nos
  DOIS lados — no servidor (`requirePermission` retorna cedo, `auth.ts:127`) e no
  client, onde `can()` é `user.is_admin === true || permissions.includes(code)`
  (`client/src/lib/auth.tsx:119`), e `is_admin` da resposta de login já é
  `role === 'admin' || group.is_admin`. Um grupo "Demo" com `is_admin=false` não
  esconderia botão nenhum enquanto o papel fosse `admin`; e trocar o papel para
  `rep` traria de volta o filtro por carteira do `scope.ts`, que é exatamente o
  que a demo não quer.

  O seed usa **`role='admin'` + grupo Administrador** e assume a consequência: o
  visitante pode apagar coisas. O que segura a base é o **reset periódico**, e o
  que garante que nada escapa da máquina é o SMTP desligado + o circuito fechado
  do WhatsApp (§8). Um grupo "Demo" de verdade exigiria mudar o produto —
  separar "vê tudo" de "pode tudo", hoje colados em `is_admin`.
- SMTP fica **cadastrado e desligado** (`enabled=false`): a tela de Conta mostra
  a configuração e o visitante não consegue disparar e-mail para fora. WhatsApp
  segue a regra própria da §8 (modo demo, sem instância real).

---

## 8. WhatsApp em modo demo — sem número conectado

### O problema

Semear `whatsapp_chats`/`whatsapp_messages` **não é suficiente**. A tela é
bloqueada antes de carregar qualquer conversa:

- `client/src/pages/WhatsApp.tsx:1480` — `if (status !== 'conectado') return <ConnectPanel/>`
  (tela de QR Code).
- `WhatsApp.tsx:1159` — `loadChats()` só roda quando `status === 'conectado'`.
- `loadStatus()` (`WhatsApp.tsx:1136`) lê `/api/whatsapp/status` (cache do banco)
  e, **se a Evolution estiver habilitada no ambiente**, confirma o estado real em
  `/api/whatsapp/connection`, que consulta a Evolution de verdade. Ou seja: pôr
  `org_whatsapp_settings.status = 'conectado'` na marra funciona em dev com
  Evolution desligada, mas **falha na VPS**, onde a Evolution está no ar para as
  orgs reais — a consulta volta desconectado e o visitante cai no QR.

### A solução: flag de org + curto-circuito nos pontos que falam com a Evolution

**Status: implementado.** Migração `072_org_demo.sql`
(`organizations.demo boolean NOT NULL DEFAULT false`) + helper
`server/src/demo.ts`:

```ts
export async function isDemoOrg(orgId: number | string): Promise<boolean>
```

Cache com TTL de 60 s: a flag só muda quando o seed roda, e o seed é outro
processo — o TTL faz a marca valer sem reiniciar o app e tira a consulta do
caminho quente (chamado a cada mensagem).

Pontos de intercepção (`server/src/routes/whatsapp.ts`, exceto o último):

| Ponto | Fora da demo | Em org demo |
|---|---|---|
| `GET /api/whatsapp/status` | lê cache do banco + `evolutionEnabled()` | `enabled: true`, `status: 'conectado'` (número vem do que o seed gravou) |
| `GET /api/whatsapp/connection` | `evo.connectionState()` | `{ status: 'conectado' }`, sem tocar na Evolution |
| `POST /connect` · `POST /disconnect` | cria instância / faz logout | `409 conta de demonstração` |
| `POST /chats/:id/send` · `/send-media` | `evo.sendText()`/`sendMedia()` → grava | **só grava** (`insertMessage`, `status:'enviado'`, `evolution_id` nulo) + broadcast no WS |
| `GET /chats` (sync de nomes de grupo) | `evo.fetchAllGroups()` | pulado — os nomes semeados já são finais |
| `GET /chats/:id/group` | `evo.groupDetails()` | devolve o nome da base, `participants: []` (em vez de 502) |
| `PATCH /chats/:id/numero` | `evo.whatsappNumbers()` valida | aceita o número informado |
| foto de perfil (`refreshFotoUrl`) | rebaixa URL na Evolution | `null` → serve só o cache semeado |
| `whatsappScheduler.ts` | exige `org_whatsapp_settings.status='conectado'` | sempre "conectado"; grava a mensagem local e marca `enviado` |

`POST /chats/:id/note` já era local por definição (nota interna nunca chama a
Evolution) e o proxy de mídia já devolve 404 sem `evolution_id` — como as
mensagens da demo são semeadas sem `evolution_id`, o `markRead` também vira
no-op naturalmente.

Resultado: a tela abre cheia, o visitante digita e a mensagem aparece na
conversa com tique — e **nada sai para número nenhum**. Verificado ponta a ponta
na base semeada: `POST /chats/:id/send` responde `status:'enviado'` com
`evolution_id: null`, e a linha entra em `whatsapp_messages` sem nenhuma chamada
à Evolution.

Cobertura: `server/test/routes-whatsapp-demo.test.ts` (10 casos) — inclui o
contraponto "org normal continua consultando a Evolution e travando o
agendamento", para a flag não virar bypass geral.

**Bônus de realismo (opcional, ~30 linhas)**: eco automático. Após um envio em
org demo, agendar `setTimeout` de 6-12 s que insere uma resposta inbound de um
pool de respostas por contexto ("Perfeito, pode faturar", "Me manda a tabela
atualizada?", "Hoje não consigo, semana que vem eu retorno") e emite no WS. A
conversa fica viva na frente do visitante. Sem persistência de estado — se o
processo cair no meio, só não chega a resposta.

### Dados semeados

18 conversas, ~550 mensagens nos últimos 30 dias, horário comercial, assunto
alimentício. Os **roteiros são escritos à mão** (`seed-demo-data.ts`,
`ROTEIROS`); o que é gerado é só o arranjo — quem conversa com quem, quando, e
quais trocas curtas de `HISTORICO_PARES` entram no histórico anterior. O motivo é
simples: o visitante *lê* o balão, e uma frase genérica derruba a demo inteira
mesmo com o resto do banco perfeito.

- **12 chats vinculados** a `company_id` + `relationship_id` + `contact_id` —
  aparecem com rótulo do cliente na lateral e abrem do funil via
  `/whatsapp?chat=ID`.
- **3 chats sem vínculo** (número solto) — exercita o botão de vincular a
  empresa.
- **2 grupos** ("Compradores Rede Bom Preço", "Equipe Sabor & Cia").
- **1 chat com merge de LID** (`whatsapp_chat_jids`), se quiser cobrir esse caminho.
- **Não lidas**: 4 chats com `nao_lidas` entre 1 e 6 → badge na lateral e no menu.
- **Mão dupla**: `from_me` misturado; outbound com `sender_user_id` da equipe
  fictícia e `include_sender_name = true` (mostra quem atendeu).
- **Notas internas**: ~9 mensagens `internal = true` (balão âmbar, nunca sai).
- **Respostas**: mensagens com `reply_to_id` apontando para outra do mesmo roteiro.
- **Status dos tiques**: mix `enviado`/`entregue`/`lido` nas outbound.
- **Mídia**: ~10 mensagens — foto de gôndola, PDF de tabela de preços e áudio
  curto. **Correção:** os arquivos são **gerados em código**
  (`seed-demo-assets.ts`), não base64 colado num `.ts`: PNG via `zlib` + CRC32,
  WAV PCM 16 bits e PDF 1.4 com a xref calculada. Binário no repositório pesa,
  não se revisa e não se justifica. O caminho de gravação é o mesmo do
  recebimento real — `saveMedia()`/`media_path` quando `WHATSAPP_MEDIA_DIR` está
  setado, `media_b64` caso contrário — e todos os mimes estão na allowlist inline
  do proxy (`INLINE_MEDIA_MIME`), então abrem no browser em vez de baixar. A foto
  de perfil de cada conversa é um avatar gerado do mesmo jeito, servido do cache
  local (`foto_path`/`foto_b64`), nunca do CDN da Meta.
- **Agendamentos** (`whatsapp_schedules`): 3 pendentes no futuro (um recorrente
  semanal com `serie_id`), 2 enviados no passado, 1 com erro. Com o
  curto-circuito acima, quando os pendentes vencerem o scheduler grava local —
  nada sai.

Roteiros de conversa (18, curados): reposição de pedido, negociação de tabela,
foto de gôndola/ruptura, cobrança de boleto, agendamento de visita, pedido de
amostra de produto novo, reclamação de prazo de entrega, pedido programado,
abertura de loja nova, conferência de recebimento, áudio do comprador, troca de
fornecedor, grupo de compradores da rede, grupo interno da equipe, contato novo
sem cadastro, consulta rápida de preço, alinhamento com a representada e
recompra de mercearia.

---

## 9. Qualidade do dado fictício (o que separa demo boa de demo óbvia)

- **Nomes reais de mercado alimentício**: "Frigorífico Vale Verde", "Laticínios
  Serra Azul", "Massas Bella Nonna", "Distribuidora Sabor & Cia", "Padaria
  Trigo Dourado", "Supermercado Bom Preço", "Mercadinho do Zé". Nada de sufixo
  numérico visível.
- **Produtos com SKU plausível**: "Mussarela Fatiada 2kg — CX c/ 5", "Refresco
  em Pó 1kg — FD c/ 10", código `LAT-0421`.
- **Valores coerentes**: ticket de mini-mercado ≠ ticket de rede; comissão de
  5-8% sobre mercadoria (sem frete, como o motor calcula).
- **Buracos propositais**: um cliente sem contato, um pedido em cotação há 20
  dias, uma conta vencida, um prospect parado há 45 dias. Base 100% perfeita
  parece falsa e esconde os alertas do dashboard — que são feature.
- **Textos em português com acento**, telefones no formato da base RFB
  (`DDD` + número, sem máscara — é assim que o ETL grava e o `format.ts`
  mascara na exibição), CNPJ com dígitos verificadores calculados, passando pelos
  validadores existentes.
- **Nome sem sufixo numérico**: o nome é `tipo + núcleo` ("Supermercado Bom
  Preço"); colidiu, o **bairro** desempata ("Padaria Estrela — Taquaral"), que é
  como rede de bairro se chama de verdade — nunca "Padaria Estrela 2".

---

## 10. Ordem de implementação

1. ~~`organizations.demo` + modo demo do WhatsApp (§8)~~ — **feito**
   (`072_org_demo.sql`, `src/demo.ts`, guards em `routes/whatsapp.ts` e
   `whatsappScheduler.ts`, `test/routes-whatsapp-demo.test.ts`).
2. ~~Migração do enum `company_source += 'demo'` + filtro em `recommend`/busca~~
   — **feito** (`073_company_source_demo.sql`, filtros em `sql/recommend.ts`,
   `routes/companies.ts` e `routes/reports.ts`, `test/companies-demo-source.test.ts`).
3. ~~`seed-demo.ts` camadas 1-4~~ — **feito**.
4. ~~Camadas 5-8 (pedidos, comissões, financeiro, metas)~~ — **feito**.
5. ~~Camadas 9-13 (agenda, rotas, e-mail, WhatsApp, logs)~~ — **feito**.
6. ~~Checklist da §6 percorrido tela a tela~~ — **feito** (via API, com a org
   semeada; todos os endpoints das telas respondem 200 com conteúdo). Captura de
   screenshots para `marca/` — **pendente**.
7. **Deploy em produção — feito** (2026-07-27). `rovva.tech` roda a org de demo
   (id 35) ao lado das 16 orgs reais. O que o deploy exigiu além do seed:
   `DEMO_PASSWORD` no `.env` da VPS **e** repassada ao container em
   `docker-compose.prod.yml` (o `.env` só alimenta a substituição do compose; quem
   lê a variável é o script rodando dentro do container).

   Cuidados que valem para qualquer redeploy: `subir-vps.sh` **sempre com
   `--skip-db`** — sem a flag ele restaura o `pgdata` local por cima do de
   produção; e o `rsync --delete` apaga o que não existe no repo, então backup
   fora de `~/rovva` (use `/root/backups-rovva/`). Dry-run do rsync **com `-v`**:
   sem verbose ele não lista as deleções e a checagem passa em falso.

   Reset diário: **não instalado, por decisão** — ver §7.


