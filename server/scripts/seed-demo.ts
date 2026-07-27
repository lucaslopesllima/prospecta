// Semeador da base de demonstração (docs/DEMO_DATA.md).
//
//   node scripts/seed-demo.ts --reset
//   node scripts/seed-demo.ts --reset --org "Sabor & Cia" --seed 42
//   node scripts/seed-demo.ts --dry-run
//
// Cria UMA organização fictícia com 6 meses de operação em regime, de modo que
// toda tela do app tenha conteúdo plausível. Escreve só em tabelas do tenant
// (org_id) e em companies/company_geocode sob `source='demo'` (migração 073, que
// mantém as fictícias fora da prospecção de qualquer outro tenant). Nunca toca
// em municipios, cnae_reference, socios ou rfb_*.
//
// DETERMINISMO: nenhum Math.random() e nenhuma data fixa. Todo sorteio sai da
// PRNG semeada (--seed) e todo timestamp deriva do primeiro dia do mês corrente
// lido do banco — a base não envelhece e duas execuções no mesmo dia produzem
// exatamente o mesmo banco (screenshots comparáveis entre ambientes).
//
// ATOMICIDADE: não há uma transação única envolvendo tudo, porque o seed reusa
// createCommissionForOrder() e materializeRecurrences() — que falam com o pool,
// não com um client. No lugar dela, qualquer erro no meio do caminho apaga a org
// recém-criada (deleteDemo abaixo): o banco volta ao estado anterior de todo
// jeito, e é o mesmo mecanismo que implementa o --dry-run.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pool, query, one } from '../src/db.ts';
import { config } from '../src/config.ts';
import { hashPassword } from '../src/auth.ts';
import { ensureDefaultGroups } from '../src/seedGroups.ts';
import { createCommissionForOrder } from '../src/commissions.ts';
import { materializeRecurrences } from '../src/recurrence.ts';
import { mediaEnabled, saveMedia, saveAvatar } from '../src/mediaStore.ts';
import { fuelEstimate } from '../src/fuel.ts';
import * as D from './seed-demo-data.ts';
import { fotoGondola, pdfTabela, wavNota, avatar } from './seed-demo-assets.ts';

// ------------------------------------------------------------------ CLI

interface Flags { reset: boolean; dryRun: boolean; org: string; seed: number }

function parseFlags(argv: string[]): Flags {
  const f: Flags = { reset: false, dryRun: false, org: 'Sabor & Cia Representações', seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reset') f.reset = true;
    else if (a === '--dry-run') f.dryRun = true;
    else if (a === '--org') f.org = argv[++i] ?? f.org;
    else if (a === '--seed') f.seed = Number(argv[++i] ?? f.seed);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else throw new Error(`flag desconhecida: ${a}`);
  }
  if (!Number.isFinite(f.seed)) throw new Error('--seed precisa ser um número');
  return f;
}

function printHelp(): void {
  console.log(`uso: node scripts/seed-demo.ts [opções]

  --reset          apaga a org de demo existente e recria do zero
  --org "Nome"     nome da organização de demonstração
  --seed 42        semente da PRNG (mesma base em todo ambiente)
  --dry-run        semeia, imprime as contagens e desfaz (não deixa nada no banco)`);
}

// ------------------------------------------------------------------ PRNG

// mulberry32: gerador pequeno, rápido e de qualidade suficiente para dado
// fictício. O ponto não é criptografia, é reprodutibilidade.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rnd: () => number;
const int = (a: number, b: number): number => a + Math.floor(rnd() * (b - a + 1));
const num = (a: number, b: number): number => a + rnd() * (b - a);
const chance = (p: number): boolean => rnd() < p;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const money = (v: number): number => Math.round(v * 100) / 100;

function shuffled<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Sorteio com peso (perfil de empresa, cidade): peso maior aparece mais.
function weighted<T extends { peso: number }>(arr: readonly T[]): T {
  const total = arr.reduce((s, x) => s + x.peso, 0);
  let r = rnd() * total;
  for (const x of arr) { r -= x.peso; if (r <= 0) return x; }
  return arr[arr.length - 1]!;
}

// ------------------------------------------------------------------ datas

// Aritmética de dias em índice inteiro (dias desde a época, meia-noite UTC).
// Simples de somar/comparar e imune a horário de verão.
const DAY_MS = 86_400_000;
const dayOf = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const dateStr = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
const weekday = (day: number): number => new Date(day * DAY_MS).getUTCDay();
const isWeekend = (day: number): boolean => weekday(day) === 0 || weekday(day) === 6;

// Timestamp com offset de Brasília FIXO. O container do app pode rodar em UTC;
// gravar "09:00" cru faria a agenda comercial aparecer às 6h para o usuário.
// -03:00 crava o horário como o Brasil o lê, independente do TZ do processo.
const TZ = '-03:00';
const at = (day: number, hour: number, minute = 0): string =>
  `${dateStr(day)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${TZ}`;

// Horário comercial, minutos de 5 em 5 (relógio de gente, não de gerador).
const businessAt = (day: number): string => at(day, int(8, 17), int(0, 11) * 5);

// Próximo dia útil a partir de `day` (rota e visita não caem no domingo).
function nextWeekday(day: number): number {
  let d = day;
  while (isWeekend(d)) d++;
  return d;
}

interface Calendario {
  hoje: number;               // índice do dia de current_date
  meses: number[];            // primeiro dia de M-5..M0 (índice 0 = M-5)
  fimDoMes: (i: number) => number; // último dia do mês i (ou hoje, se for o corrente)
}

function calendario(hojeIso: string): Calendario {
  const hoje = dayOf(hojeIso);
  const d = new Date(hoje * DAY_MS);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const meses = [-5, -4, -3, -2, -1, 0].map((off) => Math.floor(Date.UTC(y, m + off, 1) / DAY_MS));
  const fimDoMes = (i: number): number => {
    const inicio = new Date(meses[i]! * DAY_MS);
    const prox = Math.floor(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth() + 1, 1) / DAY_MS);
    return Math.min(prox - 1, hoje);
  };
  return { hoje, meses, fimDoMes };
}

// ------------------------------------------------------------------ CNPJ

// Faixa de CNPJ reservada à demonstração. NÃO é o prefixo '9' de
// server/test/helpers.ts e e2e/seed/companies.sql: aquele funciona nas fixtures,
// mas na base completa da RFB existem ~110 mil CNPJs começando com 9 — semear
// com ele estoura companies_cnpj_key. '999' é a faixa que a RFB nunca emitiu
// (zero linhas em 28 milhões, e o maior CNPJ da base é 98…), e o seed confere
// isso antes de escrever (checarFaixaCnpj) em vez de confiar na observação.
const CNPJ_RAIZ_DEMO = '999';

// Dígitos verificadores reais: o CNPJ fictício passa pelos validadores do app
// (client/src/lib/format.ts) como qualquer outro.
function cnpjComDV(raizOrdem: string): string {
  const base = raizOrdem.padStart(12, '0').slice(0, 12);
  const dv = (nums: string, pesos: number[]): number => {
    const s = nums.split('').reduce((acc, c, i) => acc + Number(c) * pesos[i]!, 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${d2}`;
}

let cnpjSeq = 0;
const proximoCnpj = (): string =>
  cnpjComDV(`${CNPJ_RAIZ_DEMO}${String(++cnpjSeq).padStart(5, '0')}0001`);

// Recusa semear se a faixa reservada não estiver livre nesta base (outra org de
// demo pendurada, import estranho, RFB mudando de faixa). Falhar aqui custa uma
// mensagem; falhar no meio custa a org inteira.
async function checarFaixaCnpj(): Promise<void> {
  const r = await one<{ n: number }>(
    "SELECT count(*)::int AS n FROM companies WHERE cnpj LIKE $1 AND source <> 'demo'",
    [`${CNPJ_RAIZ_DEMO}%`],
  );
  if (Number(r!.n) > 0) {
    throw new Error(`a faixa de CNPJ ${CNPJ_RAIZ_DEMO}* já tem ${r!.n} empresa(s) não-demo — escolha outra faixa em CNPJ_RAIZ_DEMO`);
  }
}

// ------------------------------------------------------------------ telefone

const telefoneFixo = (ddd: string): string => `${ddd}3${int(2, 9)}${int(100000, 999999)}`;
const telefoneCel = (ddd: string): string => `${ddd}9${int(6, 9)}${int(1000000, 9999999)}`;

// ------------------------------------------------------------------ tipos

interface Usuario { id: number; nome: string; email: string; papel: 'demo' | 'gerente' | 'vendedor' | 'financeiro' }
interface Representada { id: number; def: D.DemoRepresentada; marcas: number[]; itens: ItemCatalogo[]; tabelas: number[] }
interface ItemCatalogo { id: number; def: D.DemoProduto }
interface Empresa {
  id: number; nome: string; razao: string; cnpj: string;
  cidade: D.DemoCidade; lat: number; lon: number; perfil: D.DemoPerfil;
}
interface Relacionamento {
  id: number; empresa: Empresa; status: string; owner: Usuario | null;
  representada: Representada; contatos: number[];
}
interface Pedido {
  criadoEm: number; status: string; rel: Relacionamento; rep: Representada;
  owner: Usuario; itens: { item: ItemCatalogo; qtd: number; desconto: number }[];
  tabela: number; frete: number; carrierId: number; contatoId: number | null;
}

// ------------------------------------------------------------------ seed

const NOTA_MEDIA_ITENS = 5;

async function seed(flags: Flags): Promise<{ orgId: number; contagens: Record<string, number> }> {
  rnd = mulberry32(flags.seed);
  cnpjSeq = 0;

  await checarFaixaCnpj();
  const hojeRow = await one<{ hoje: string }>("SELECT to_char(current_date, 'YYYY-MM-DD') AS hoje");
  const cal = calendario(hojeRow!.hoje);

  // ---------------------------------------------------------- 1. org, usuários

  const orgCidade = D.CIDADES[0]!; // escritório em Campinas — origem das rotas
  const org = await one<{ id: number }>(
    `INSERT INTO organizations
       (nome, plano, cnpj, telefone, cep, logradouro, numero, complemento, bairro, cidade, uf,
        origem_lat, origem_lon, inatividade_dias, tipo_conta, demo)
     VALUES ($1,'pro',$2,$3,'13025151','RUA MARIA MONTEIRO','1420','Conjunto 42','CAMBUI',$4,'SP',
             $5,$6,30,'escritorio',true)
     RETURNING id`,
    [flags.org, proximoCnpj(), telefoneFixo(orgCidade.ddd), orgCidade.nome,
      orgCidade.lat, orgCidade.lon],
  );
  const orgId = Number(org!.id);

  // Mesmas etapas que /api/auth/register cria para qualquer org nova. Repetidas
  // aqui (e não importadas) porque a lista mora dentro do handler da rota; se
  // divergirem, o funil da demo deixa de espelhar o funil padrão do produto.
  const STAGES = ['Prospecção', 'Conscientização', 'Interesse', 'Avaliação', 'Negociação', 'Compra', 'Fidelização'];
  const stageIds: number[] = [];
  for (let i = 0; i < STAGES.length; i++) {
    const r = await one<{ id: number }>(
      'INSERT INTO stages (org_id, nome, ordem) VALUES ($1,$2,$3) RETURNING id', [orgId, STAGES[i], i + 1],
    );
    stageIds.push(Number(r!.id));
  }

  await ensureDefaultGroups(orgId);
  const grupos = new Map(
    (await query<{ id: number; nome: string }>('SELECT id, nome FROM permission_groups WHERE org_id = $1', [orgId]))
      .map((g) => [g.nome, Number(g.id)]),
  );

  // Login da demo: usuário à parte da equipe fictícia (§7). role='admin' porque
  // é o que faz TODAS as telas aparecerem cheias — scope.ts filtra por carteira
  // para quem não é admin, e o visitante veio observar a operação inteira, não
  // virar um dos vendedores. Consequência assumida: is_admin faz bypass do RBAC
  // no servidor E no can() do client, então não existe "grupo Demo" capaz de
  // esconder botão destrutivo sem tirar a visão global junto — o que segura a
  // base é o reset periódico, e o WhatsApp não sai da máquina (demo.ts).
  const senhaDemo = process.env.DEMO_PASSWORD ?? (process.env.NODE_ENV === 'production' ? '' : 'demo123');
  if (!senhaDemo) throw new Error('DEMO_PASSWORD vazio — defina a senha do login de demonstração');
  if (senhaDemo.length < 6) throw new Error('DEMO_PASSWORD precisa de ao menos 6 caracteres');

  const equipe: { nome: string; email: string; papel: Usuario['papel']; grupo: string }[] = [
    { nome: 'Demonstração Rovva', email: 'adm@rovvatech.com.br', papel: 'demo', grupo: 'Administrador' },
    { nome: 'Ricardo Matos', email: 'ricardo.matos@saborecia.com.br', papel: 'gerente', grupo: 'Gerente' },
    { nome: 'Juliana Prado', email: 'juliana.prado@saborecia.com.br', papel: 'vendedor', grupo: 'Vendedor' },
    { nome: 'Marcos Tavares', email: 'marcos.tavares@saborecia.com.br', papel: 'vendedor', grupo: 'Vendedor' },
    { nome: 'Carla Ferraz', email: 'carla.ferraz@saborecia.com.br', papel: 'financeiro', grupo: 'Financeiro' },
  ];
  const usuarios: Usuario[] = [];
  for (const u of equipe) {
    // A equipe fictícia não é login: senha aleatória de 32 bytes, descartada aqui
    // mesmo. Só o usuário de demonstração tem senha conhecida.
    const senha = u.papel === 'demo' ? senhaDemo : randomBytes(32).toString('hex');
    const r = await one<{ id: number }>(
      `INSERT INTO users (org_id, email, senha_hash, role, nome, ativo, group_id)
       VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
      [orgId, u.email, await hashPassword(senha), u.papel === 'demo' ? 'admin' : 'rep', u.nome, grupos.get(u.grupo)],
    );
    usuarios.push({ id: Number(r!.id), nome: u.nome, email: u.email, papel: u.papel });
  }
  const gerente = usuarios.find((u) => u.papel === 'gerente')!;
  const vendedores = usuarios.filter((u) => u.papel === 'vendedor');
  const financeiro = usuarios.find((u) => u.papel === 'financeiro')!;
  const operacao = [gerente, ...vendedores];

  await query(
    `INSERT INTO org_tax_defaults (org_id, icms_pct, ipi_pct, st_pct, pis_pct, cofins_pct, iss_pct)
     VALUES ($1, 18, 0, 0, $2, $3, 0)`,
    [orgId, D.TAXAS_PADRAO.pis, D.TAXAS_PADRAO.cofins],
  );
  // SMTP cadastrado porém DESLIGADO: a tela de Conta mostra a configuração e o
  // visitante não consegue disparar e-mail para fora (§7).
  await query(
    `INSERT INTO org_smtp_settings (org_id, host, port, secure, username, from_email, from_name, enabled)
     VALUES ($1,'smtp.saborecia.com.br',587,false,'contato@saborecia.com.br',
             'contato@saborecia.com.br',$2,false)`,
    [orgId, flags.org],
  );

  // Território da recomendação: enabled_regions é GLOBAL (não tem org_id) — o
  // ETL liga UF a UF em produção. Aqui só garante SP, sem mexer no que já existe.
  await query("INSERT INTO enabled_regions (uf, regiao) VALUES ('SP','SE') ON CONFLICT (uf) DO NOTHING");

  const cenarioIds: number[] = [];
  for (const nome of D.CENARIOS) {
    const r = await one<{ id: number }>(
      'INSERT INTO funnel_scenarios (org_id, nome) VALUES ($1,$2) RETURNING id', [orgId, nome]);
    cenarioIds.push(Number(r!.id));
  }
  const acaoIds: number[] = [];
  for (const nome of D.ACOES) {
    const r = await one<{ id: number }>(
      'INSERT INTO funnel_actions (org_id, nome) VALUES ($1,$2) RETURNING id', [orgId, nome]);
    acaoIds.push(Number(r!.id));
  }

  // ---------------------------------------------------------- 2-3. representadas, catálogo, tabelas

  const representadas: Representada[] = [];
  for (const def of D.REPRESENTADAS) {
    const rep = await one<{ id: number }>(
      `INSERT INTO represented_companies (org_id, nome, cnpj, segmento, site, contato, notas, ativo, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, def.nome, proximoCnpj(), def.segmento, def.site, def.contato, def.notas, def.ativo,
        at(cal.meses[0]! - int(30, 400), 10)],
    );
    const repId = Number(rep!.id);

    const marcas: number[] = [];
    for (const m of def.marcas) {
      const r = await one<{ id: number }>(
        'INSERT INTO represented_brands (org_id, represented_id, nome) VALUES ($1,$2,$3) RETURNING id',
        [orgId, repId, m]);
      marcas.push(Number(r!.id));
    }

    const itens: ItemCatalogo[] = [];
    for (const p of def.produtos) {
      const r = await one<{ id: number }>(
        `INSERT INTO catalog_items
           (org_id, nome, codigo, descricao, preco, represented_id, ativo, unidade_medida,
            icms_pct, ipi_pct, st_pct, pis_pct, cofins_pct, iss_pct)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,0) RETURNING id`,
        [orgId, p.nome, p.codigo, `${def.segmento} · ${pick(def.marcas)}`, p.preco, repId, p.unidade,
          p.icms, p.ipi ?? 0, p.st ?? 0, D.TAXAS_PADRAO.pis, D.TAXAS_PADRAO.cofins],
      );
      itens.push({ id: Number(r!.id), def: p });
    }

    // Duas tabelas vigentes por representada ativa (§6): a Padrão e a de
    // Rede/Atacado, 8% abaixo e com desconto máximo menor.
    const tabelas: number[] = [];
    if (def.ativo) {
      for (const t of [
        { nome: 'Tabela Padrão', fator: 1, descMax: 8 },
        { nome: 'Tabela Rede / Atacado', fator: 0.92, descMax: 4 },
      ]) {
        const pt = await one<{ id: number }>(
          `INSERT INTO price_tables (org_id, represented_id, nome, vigencia_inicio, vigencia_fim, ativo)
           VALUES ($1,$2,$3,$4,NULL,true) RETURNING id`,
          [orgId, repId, t.nome, dateStr(cal.meses[0]!)],
        );
        const ptId = Number(pt!.id);
        for (const it of itens) {
          await query(
            `INSERT INTO price_table_items (price_table_id, catalog_item_id, preco, desconto_max_pct)
             VALUES ($1,$2,$3,$4)`,
            [ptId, it.id, money(it.def.preco * t.fator), t.descMax],
          );
        }
        tabelas.push(ptId);
      }
    }
    representadas.push({ id: repId, def, marcas, itens, tabelas });
  }
  const repsAtivas = representadas.filter((r) => r.def.ativo);

  // ---------------------------------------------------------- 4. empresas, funil, contatos

  const TOTAL_EMPRESAS = 185;
  const usados = new Set<string>();
  const empresas: Empresa[] = [];

  for (let i = 0; i < TOTAL_EMPRESAS; i++) {
    const perfil = weighted(D.PERFIS);
    const cidade = weighted(D.CIDADES);
    // Nome sem sufixo numérico: o núcleo vira "Supermercado Bom Preço". Repetiu a
    // combinação, o bairro desempata ("Padaria Estrela — Taquaral") — que é como
    // rede de bairro se chama de verdade.
    let nome = `${perfil.tipo} ${pick(D.NUCLEOS)}`;
    if (usados.has(nome)) {
      const bairro = pick(D.BAIRROS);
      nome = `${nome} — ${bairro.charAt(0)}${bairro.slice(1).toLowerCase()}`;
    }
    if (usados.has(nome)) continue; // colisão dupla: pula, o total é aproximado
    usados.add(nome);

    const semNucleo = nome.replace(`${perfil.tipo} `, '').split(' — ')[0]!;
    const razao = `${semNucleo.toUpperCase().replace(/[^A-ZÀ-Ú ]/g, '')} ${perfil.razaoSufixo}`.replace(/\s+/g, ' ').trim();
    const cnpj = proximoCnpj();
    // Jitter em torno do centroide do município: o mapa mostra pontos espalhados
    // pela cidade, não 185 marcadores empilhados na mesma coordenada.
    const lat = cidade.lat + num(-0.035, 0.035);
    const lon = cidade.lon + num(-0.045, 0.045);
    const porte = perfil.cnae === 4639701 || perfil.cnae === 4711302
      ? pick(['pequeno', 'demais'] as const) : pick(['micro', 'micro', 'pequeno'] as const);

    const r = await one<{ id: number }>(
      `INSERT INTO companies
         (cnpj, razao_social, nome_fantasia, cnae_principal, cnae_secundarios, municipio_id, uf, regiao,
          geom, porte, capital_social, situacao_cadastral, source,
          logradouro, numero, bairro, cep, telefone1, email,
          data_inicio_atividade, matriz_filial, natureza_juridica, qualificacao_responsavel)
       VALUES ($1,$2,$3,$4,'{}',$5,'SP','SE',
               ST_SetSRID(ST_MakePoint($7,$6),4326)::geography,$8,$9,'ativa','demo',
               $10,$11,$12,$13,$14,$15,$16,1,2062,49)
       RETURNING id`,
      [cnpj, razao, nome, perfil.cnae, cidade.id, lat, lon, porte,
        money(num(20_000, 900_000)), pick(D.LOGRADOUROS), String(int(12, 3800)), pick(D.BAIRROS),
        `130${int(10, 99)}${int(100, 999)}`, telefoneFixo(cidade.ddd),
        `contato@${semNucleo.toLowerCase().replace(/[^a-z]/g, '')}.com.br`,
        dateStr(cal.hoje - int(400, 9000))],
    );
    const id = Number(r!.id);
    await query(
      `INSERT INTO company_geocode (company_id, lat, lon, precisao, fonte)
       VALUES ($1,$2,$3,'rua','demo')`, [id, lat, lon],
    );
    empresas.push({ id, nome, razao, cnpj, cidade, lat, lon, perfil });
  }

  // Funil: 60% cliente, 30% prospect, 10% descartado (§5).
  const rels: Relacionamento[] = [];
  const embaralhadas = shuffled(empresas);
  const nCliente = Math.round(embaralhadas.length * 0.6);
  const nProspect = Math.round(embaralhadas.length * 0.3);

  for (let i = 0; i < embaralhadas.length; i++) {
    const emp = embaralhadas[i]!;
    const status = i < nCliente ? 'cliente' : i < nCliente + nProspect ? 'prospect' : 'descartado';
    const rep = pick(repsAtivas);
    // ~10 contas sem dono alimentam o bucket "sem carteira" da tela Carteiras.
    const owner = i % 18 === 7 ? null : (status === 'descartado' ? pick(operacao) : pick(vendedores));

    // Cliente vive no fim do funil; prospect se espalha pelas etapas iniciais.
    const stageId = status === 'cliente'
      ? (chance(0.6) ? stageIds[5]! : stageIds[6]!)
      : status === 'descartado' ? stageIds[int(1, 4)]!
        : stageIds[int(0, 4)]!;

    const criadoEm = cal.meses[0]! - int(0, 150);
    // Buracos propositais (§9): ~15 prospects sem contato há mais de 30 dias e
    // negócios parados no mesmo stage — são eles que acendem os alertas do
    // dashboard, que é feature, não falha da base.
    const parado = status === 'prospect' && i % 4 === 1;
    const contatoDias = status === 'cliente' ? int(1, 25) : parado ? int(34, 70) : int(2, 28);
    const stageDias = parado ? int(32, 80) : int(1, 26);

    const valor = status === 'descartado'
      ? money(num(perfil0(emp), perfil1(emp) * 0.6))
      : money(num(perfil0(emp) * 1.2, perfil1(emp) * 2.4));

    const r = await one<{ id: number }>(
      `INSERT INTO company_relationships
         (org_id, company_id, owner_user_id, stage_id, status, valor_estimado, notas, represented_id,
          data_contato, previsao_data, marca_id, cenario_id, acao_id, motivo_descarte,
          created_at, updated_at, stage_changed_at, ativo)
       VALUES ($1,$2,$3,$4,$5::rel_status,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [orgId, emp.id, owner?.id ?? null, stageId, status, valor,
        chance(0.55) ? pick(D.NOTAS_FUNIL) : null, rep.id,
        dateStr(cal.hoje - contatoDias),
        status === 'prospect' ? dateStr(cal.hoje + int(5, 60)) : null,
        pick(rep.marcas), pick(cenarioIds), pick(acaoIds),
        status === 'descartado' ? pick(D.MOTIVOS_DESCARTE) : null,
        at(criadoEm, 9), at(cal.hoje - contatoDias, 15), at(cal.hoje - stageDias, 11),
        // Cliente inativo: soft-state separado do status (migração 039).
        status !== 'descartado' && i % 23 !== 5],
    );
    rels.push({ id: Number(r!.id), empresa: emp, status, owner, representada: rep, contatos: [] });
  }

  // Contatos: 1-2 por empresa, com um punhado de contas propositalmente sem
  // contato nenhum (§9) para a tela mostrar o estado vazio real.
  for (let i = 0; i < rels.length; i++) {
    const rel = rels[i]!;
    if (i % 13 === 4) continue; // cliente sem contato cadastrado
    const quantos = chance(0.45) ? 2 : 1;
    for (let k = 0; k < quantos; k++) {
      const nome = `${pick(D.PRIMEIROS)} ${pick(D.SOBRENOMES)}`;
      const c = await one<{ id: number }>(
        `INSERT INTO contacts (org_id, nome, cargo, email, telefone, company_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orgId, nome, pick(D.CARGOS),
          `${nome.toLowerCase().normalize('NFD').replace(/[^a-z ]/g, '').replace(' ', '.')}@${rel.empresa.nome.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.com.br`,
          k === 0 ? telefoneCel(rel.empresa.cidade.ddd) : telefoneFixo(rel.empresa.cidade.ddd),
          rel.empresa.id, at(cal.meses[0]! - int(0, 120), 10)],
      );
      const cid = Number(c!.id);
      rel.contatos.push(cid);
      await query('INSERT INTO relationship_contacts (relationship_id, contact_id) VALUES ($1,$2)', [rel.id, cid]);
    }
  }
  // Contatos das representadas (aparecem na aba de contatos por representada).
  for (const rep of representadas) {
    const nome = rep.def.contato.split(' · ')[0]!;
    await query(
      `INSERT INTO contacts (org_id, nome, cargo, email, telefone, represented_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, nome, rep.def.contato.split(' · ')[1] ?? 'Comercial',
        `${nome.split(' ')[0]!.toLowerCase()}@${new URL(rep.def.site).hostname.replace('www.', '')}`,
        telefoneCel('11'), rep.id, at(cal.meses[0]! - int(0, 200), 10)],
    );
  }

  // Mix vendido por conta (relationship_catalog) — alimenta a sugestão de itens
  // ao abrir um pedido a partir do funil.
  for (const rel of rels) {
    if (rel.status !== 'cliente') continue;
    for (const it of shuffled(rel.representada.itens).slice(0, int(2, 5))) {
      await query(
        'INSERT INTO relationship_catalog (relationship_id, catalog_item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [rel.id, it.id]);
    }
  }

  // Private labels: marcas de terceiros para as quais a empresa trabalha. É
  // informação de cadastro — o vínculo diz "essa empresa produz/fornece para a
  // marca X" — e os contatos que respondem por esse acordo ficam pendurados na
  // mesma marca (é sempre contato DA empresa vinculada; contato solto na marca
  // não teria a quem se referir).
  //
  // Quem trabalha para marca de terceiro no varejo alimentar é quem tem escala de
  // produção ou de fornecimento: distribuidora/atacado e supermercado. Padaria de
  // esquina e lanchonete ficam de fora — é o que torna a informação uma
  // informação, e não uma etiqueta que todo mundo tem.
  const etiquetas: number[] = [];
  const fornecedores = shuffled(
    rels.filter((r) => r.status !== 'descartado'
      && (r.empresa.perfil.cnae === 4639701 || r.empresa.perfil.cnae === 4711302)),
  );

  let corte = 0;
  for (const m of D.PRIVATE_LABELS) {
    const label = await one<{ id: number }>(
      `INSERT INTO private_labels (org_id, nome, descricao, cor) VALUES ($1,$2,$3,$4) RETURNING id`,
      [orgId, m.nome, `Marca própria da ${m.dono}. Empresas vinculadas produzem ou fornecem sob esta marca.`, m.cor],
    );
    const labelId = Number(label!.id);
    etiquetas.push(labelId);

    // Fatias sem sobreposição: cada empresa trabalha para no máximo uma marca, o
    // que é o normal (acordo de private label costuma ter exclusividade).
    const quantas = int(3, 6);
    for (const f of fornecedores.slice(corte, corte + quantas)) {
      await query(
        `INSERT INTO private_label_companies (private_label_id, company_id, org_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [labelId, f.empresa.id, orgId]);
      // Contato do cadastro DESSA empresa que responde pela marca.
      for (const c of f.contatos.slice(0, chance(0.4) ? 2 : 1)) {
        await query(
          `INSERT INTO private_label_contacts (private_label_id, contact_id, org_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [labelId, c, orgId]);
      }
    }
    corte += quantas;
  }

  // ---------------------------------------------------------- 5. veículos e transportadoras

  const veiculos: number[] = [];
  for (let i = 0; i < D.VEICULOS.length; i++) {
    const v = D.VEICULOS[i]!;
    const r = await one<{ id: number }>(
      `INSERT INTO vehicles (org_id, nome, placa, combustivel, consumo_kml, tanque_litros, preco_litro, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [orgId, v.nome, v.placa, v.combustivel, v.consumo, v.tanque, v.preco, operacao[i]?.id ?? null]);
    veiculos.push(Number(r!.id));
  }

  const carriers: number[] = [];
  for (const t of D.TRANSPORTADORAS) {
    const r = await one<{ id: number }>(
      `INSERT INTO carriers (org_id, nome, cnpj, telefone, email, contato, observacoes, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
      [orgId, t.nome, proximoCnpj(), telefoneFixo('19'),
        `operacao@${t.nome.toLowerCase().replace(/[^a-z]/g, '')}.com.br`, t.contato, t.obs]);
    carriers.push(Number(r!.id));
  }

  // ---------------------------------------------------------- 6. pedidos e regras de comissão

  // Regras ANTES dos pedidos: createCommissionForOrder resolve a regra vigente
  // na data do faturamento — regra criada depois não comissiona nada.
  const vigenciaRegras = dateStr(cal.meses[0]! - 40);
  for (const rep of repsAtivas) {
    await query(
      `INSERT INTO commission_rules (org_id, represented_id, percent, vendedor_split_pct, vigencia_inicio, ativo)
       VALUES ($1,$2,$3,60,$4,true)`, [orgId, rep.id, rep.def.comissao, vigenciaRegras]);
  }
  // Específicas (precedência produto > cliente > vendedor > geral).
  const repProduto = repsAtivas[0]!;
  await query(
    `INSERT INTO commission_rules (org_id, represented_id, catalog_item_id, percent, vendedor_split_pct, vigencia_inicio, ativo)
     VALUES ($1,$2,$3,9,60,$4,true)`, [orgId, repProduto.id, repProduto.itens[0]!.id, vigenciaRegras]);
  const clienteRede = rels.find((r) => r.status === 'cliente' && r.empresa.perfil.cnae === 4711302)
    ?? rels.find((r) => r.status === 'cliente')!;
  await query(
    `INSERT INTO commission_rules (org_id, represented_id, company_id, percent, vendedor_split_pct, vigencia_inicio, ativo)
     VALUES ($1,$2,$3,4.5,60,$4,true)`, [orgId, clienteRede.representada.id, clienteRede.empresa.id, vigenciaRegras]);
  for (const v of vendedores) {
    await query(
      `INSERT INTO commission_rules (org_id, represented_id, user_id, percent, vendedor_split_pct, vigencia_inicio, ativo)
       VALUES ($1,$2,$3,$4,70,$5,true)`,
      [orgId, repsAtivas[1]!.id, v.id, repsAtivas[1]!.def.comissao + 1, vigenciaRegras]);
  }

  // Sazonalidade alimentícia (§4): volume crescente, leve queda em M-3, pico em
  // M-1 (datas comemorativas).
  //
  // O mês corrente é PROPORCIONAL ao tempo já decorrido dele, não uma fração
  // fixa. Como a base é ancorada em current_date e roda todo dia, um valor fixo
  // (ex.: 60% do mês anterior) só fica plausível no meio do mês: rodando no dia
  // 3 pareceria um mês recordista, e no dia 28, um colapso de vendas. Escalar
  // pelo calendário mantém o ritmo coerente em qualquer dia da execução.
  const inicioM0 = cal.meses[5]!;
  const d0 = new Date(inicioM0 * DAY_MS);
  const diasDoMes = Math.floor(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1) / DAY_MS) - inicioM0;
  const fracaoMes = (cal.hoje - inicioM0 + 1) / diasDoMes;
  const PEDIDOS_POR_MES = [46, 52, 44, 58, 68, Math.max(10, Math.round(68 * fracaoMes))];
  const clientes = rels.filter((r) => r.status === 'cliente');
  const prospects = rels.filter((r) => r.status === 'prospect');

  const pedidos: Pedido[] = [];
  for (let m = 0; m < PEDIDOS_POR_MES.length; m++) {
    const inicio = cal.meses[m]!, fim = cal.fimDoMes(m);
    for (let k = 0; k < PEDIDOS_POR_MES[m]!; k++) {
      // Cotação nasce em prospect; pedido de verdade, em cliente.
      const emCotacao = chance(0.16);
      const rel = emCotacao && prospects.length ? pick(prospects) : pick(clientes);
      const rep = rel.representada;
      const owner = rel.owner ?? pick(vendedores);
      const dia = nextWeekdayDentro(inicio + int(0, Math.max(0, fim - inicio)), fim);

      // O status sai da IDADE do pedido, não do mês: um pedido de ontem ainda
      // está em cotação ou saindo, um de três semanas atrás já foi entregue. É o
      // que dá um pipeline de verdade no mês corrente (os últimos dias cheios de
      // pedido em trânsito) sem esvaziar o faturamento — e o que faz a curva de
      // vendas do mês acompanhar o calendário em vez de despencar por regra fixa.
      const idade = cal.hoje - dia;
      const status = chance(0.03) ? 'cancelado' // morre em qualquer estágio
        : emCotacao
          // Cotação velha que ninguém fechou é o "buraco proposital" do §9.
          ? (idade > 25 ? pick(['cotacao', 'cancelado']) : pick(['cotacao', 'cotacao', 'rascunho']))
          : idade > 14 ? pick(['entregue', 'entregue', 'entregue', 'faturado'])
            : idade > 6 ? pick(['faturado', 'faturado', 'faturado', 'entregue', 'enviado'])
              : pick(['enviado', 'enviado', 'faturado', 'rascunho']);

      const alvo = num(rel.empresa.perfil.ticket[0], rel.empresa.perfil.ticket[1]);
      const escolhidos = shuffled(rep.itens).slice(0, int(3, 8));
      const itens = escolhidos.map((item) => {
        const unit = item.def.preco;
        const qtd = Math.max(1, Math.round((alvo / escolhidos.length) / unit));
        return { item, qtd, desconto: chance(0.35) ? Number(num(1, 6).toFixed(2)) : 0 };
      });

      pedidos.push({
        criadoEm: dia, status, rel, rep, owner, itens,
        tabela: rel.empresa.perfil.cnae === 4711302 || rel.empresa.perfil.cnae === 4639701
          ? rep.tabelas[1]! : rep.tabelas[0]!,
        frete: chance(0.4) ? money(num(80, 420)) : 0,
        carrierId: pick(carriers),
        contatoId: rel.contatos.length ? pick(rel.contatos) : null,
      });
    }
  }
  // orders.numero é sequencial por org: número baixo = pedido antigo (§2).
  pedidos.sort((a, b) => a.criadoEm - b.criadoEm);

  const faturados: number[] = [];
  const pedidoIds: number[] = [];
  for (let i = 0; i < pedidos.length; i++) {
    const p = pedidos[i]!;
    const numero = i + 1;
    const emitido = ['enviado', 'faturado', 'entregue'].includes(p.status)
      ? Math.min(cal.hoje, p.criadoEm + int(0, 2)) : null;
    const faturado = ['faturado', 'entregue'].includes(p.status)
      ? Math.min(cal.hoje, p.criadoEm + int(1, 5)) : null;
    // Faturamento é o que a comissão enxerga: inserir já como 'faturado' e só
    // depois mover para 'entregue' reproduz a transição real da UI (o motor de
    // comissão só olha pedido com status='faturado').
    const statusInicial = p.status === 'entregue' ? 'faturado' : p.status;

    const o = await one<{ id: number }>(
      `INSERT INTO orders
         (org_id, numero, relationship_id, company_id, represented_id, owner_user_id, price_table_id,
          status, validade, condicao_pagamento, frete, observacoes, nf_numero,
          emitido_em, faturado_em, carrier_id, contact_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::order_status,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [orgId, numero, p.rel.id, p.rel.empresa.id, p.rep.id, p.owner.id, p.tabela,
        statusInicial, dateStr(p.criadoEm + 30),
        pick(['À vista', '14 dias', '21 dias', '28 dias', '30/60 dias']), p.frete,
        chance(0.25) ? pick(D.NOTAS_FUNIL) : null,
        faturado ? String(int(10000, 99999)) : null,
        emitido ? businessAt(emitido) : null,
        faturado ? businessAt(faturado) : null,
        p.carrierId, p.contatoId, businessAt(p.criadoEm), businessAt(faturado ?? p.criadoEm)],
    );
    const orderId = Number(o!.id);
    pedidoIds.push(orderId);

    // Itens num INSERT só (multi-row): 300 pedidos × 5 itens em 300 round trips
    // em vez de 1500.
    const vals: unknown[] = [];
    const tuplas = p.itens.map((it, k) => {
      const base = k * 10;
      vals.push(orderId, it.item.id, it.item.def.nome, it.qtd, it.item.def.preco, it.desconto,
        it.item.def.ipi ?? 0, it.item.def.st ?? 0, it.item.def.icms, it.item.def.unidade);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},`
        + `$${base + 7},$${base + 8},$${base + 9},${D.TAXAS_PADRAO.pis},${D.TAXAS_PADRAO.cofins},$${base + 10})`;
    });
    await query(
      `INSERT INTO order_items
         (order_id, catalog_item_id, descricao_snapshot, qtd, preco_unit, desconto_pct,
          ipi_pct, st_pct, icms_pct, pis_pct, cofins_pct, unidade_medida_snapshot)
       VALUES ${tuplas.join(',')}`,
      vals,
    );
    // Mesma regra do servidor: total sempre recalculado do banco (order_items.total
    // é coluna GENERATED) + frete. Nada de somar dinheiro em JS.
    await query(
      `UPDATE orders SET total = COALESCE((SELECT SUM(total) FROM order_items WHERE order_id = $1),0) + frete
       WHERE id = $1`, [orderId]);

    if (faturado) faturados.push(orderId);
  }

  // Comissões pelo motor real (§2): percedência produto > cliente > vendedor >
  // geral resolvida por createCommissionForOrder, para a tela de Comissões bater
  // com as regras que ela mesma exibe.
  for (const id of faturados) await createCommissionForOrder(id);

  // Só agora o pedido entregue vira 'entregue' — a comissão já existe.
  for (let i = 0; i < pedidos.length; i++) {
    if (pedidos[i]!.status === 'entregue') {
      await query("UPDATE orders SET status = 'entregue' WHERE id = $1", [pedidoIds[i]!]);
    }
  }

  // ---------------------------------------------------------- 7. financeiro

  const categorias = new Map<string, number>();
  for (const c of D.CATEGORIAS_FINANCEIRAS) {
    const r = await one<{ id: number }>(
      `INSERT INTO finance_categories (org_id, nome, grupo_dre, kind, ativo)
       VALUES ($1,$2,$3,$4::finance_kind,true) RETURNING id`,
      [orgId, c.nome, c.grupo, c.kind]);
    categorias.set(c.nome, Number(r!.id));
  }

  // Baixa das comissões antigas — mesmo efeito de POST /commissions/:id/receber
  // (settleEntry em routes/commissions.ts): marca recebida/divergente e espelha
  // no financeiro como conta recebida e liquidada.
  const entries = await query<{
    id: string; order_id: string; company_id: string; represented_id: string; user_id: string | null;
    valor_previsto: string; competencia: string; numero: number; rep_nome: string;
  }>(
    `SELECT e.id, e.order_id, o.company_id, e.represented_id, e.user_id, e.valor_previsto,
            e.competencia, o.numero, r.nome AS rep_nome
       FROM commission_entries e
       JOIN orders o ON o.id = e.order_id
       JOIN represented_companies r ON r.id = e.represented_id
      WHERE e.org_id = $1
      ORDER BY e.competencia, e.id`,
    [orgId],
  );

  const compM1 = dateStr(cal.meses[4]!);
  let nDivergentes = 0;
  for (const e of entries) {
    const comp = String(e.competencia).slice(0, 10);
    // Competências fechadas são liquidadas no mês seguinte; M-1 fica pela metade
    // (comissão em trânsito) e o mês corrente segue previsto.
    const liquidar = comp < compM1 || (comp === compM1 && chance(0.5));
    if (!liquidar) continue;
    const previsto = Number(e.valor_previsto);
    // Uma divergência proposital: a indústria pagou menos que o previsto e a
    // tela precisa mostrar o alerta (§6).
    const divergente = nDivergentes === 0 && comp === dateStr(cal.meses[2]!);
    const recebido = money(divergente ? previsto * 0.86 : previsto);
    const pagoEm = dateStr(Math.min(cal.hoje, dayOf(comp) + int(38, 50)));

    const fin = await one<{ id: number }>(
      `INSERT INTO finance_entries
         (org_id, kind, descricao, valor, vencimento, liquidacao_data, status, categoria, categoria_id,
          company_id, represented_id, owner_user_id)
       VALUES ($1,'receber',$2,$3,$4,$4,'liquidado','comissao',$5,$6,$7,$8) RETURNING id`,
      [orgId, `Comissão pedido #${e.numero} · ${e.rep_nome}`, recebido, pagoEm,
        categorias.get('Comissões recebidas'), e.company_id, e.represented_id, e.user_id],
    );
    await query(
      `UPDATE commission_entries
          SET valor_recebido = $2, recebida_em = $3, status = $4::commission_status,
              observacao = $5, finance_entry_id = $6
        WHERE id = $1`,
      [e.id, recebido, pagoEm, divergente ? 'divergente' : 'recebida',
        divergente ? 'Indústria descontou devolução de 2 caixas com avaria.' : null, fin!.id],
    );
    if (divergente) nDivergentes++;
  }

  // Despesas fixas: um MODELO mensal por conta no mês M-5 e o materializador do
  // app (recurrence.ts) gera os meses seguintes — a tela de Financeiro mostra a
  // série exatamente como mostraria se um usuário tivesse cadastrado.
  const modelos: number[] = [];
  for (const d of D.DESPESAS_FIXAS) {
    const venc = dateStr(cal.meses[0]! + d.dia - 1);
    const r = await one<{ id: number }>(
      `INSERT INTO finance_entries
         (org_id, kind, descricao, valor, vencimento, status, categoria, categoria_id,
          owner_user_id, recorrencia, created_at)
       VALUES ($1,'pagar',$2,$3,$4,'liquidado',$5,$6,$7,'mensal',$8) RETURNING id`,
      [orgId, d.descricao, d.valor, venc, d.categoria, categorias.get(d.categoria) ?? null,
        financeiro.id, at(cal.meses[0]!, 9)],
    );
    modelos.push(Number(r!.id));
  }
  await materializeRecurrences(orgId);
  // Filhos vencidos já foram pagos; o do mês corrente segue em aberto.
  await query(
    `UPDATE finance_entries
        SET status = 'liquidado', liquidacao_data = vencimento
      WHERE org_id = $1 AND recorrencia_origem_id = ANY($2::bigint[]) AND vencimento < current_date`,
    [orgId, modelos],
  );
  await query(
    `UPDATE finance_entries SET liquidacao_data = vencimento
      WHERE org_id = $1 AND id = ANY($2::bigint[])`, [orgId, modelos],
  );

  // Despesas variáveis espalhadas pelos 6 meses + os buracos propositais:
  // vencidas em aberto, vencendo esta semana.
  for (let m = 0; m < 6; m++) {
    const inicio = cal.meses[m]!, fim = cal.fimDoMes(m);
    for (let k = 0; k < int(6, 10); k++) {
      const d = pick(D.DESPESAS_VARIAVEIS);
      const venc = inicio + int(0, Math.max(0, fim - inicio));
      const passado = venc < cal.hoje;
      await query(
        `INSERT INTO finance_entries
           (org_id, kind, descricao, valor, vencimento, liquidacao_data, status, categoria, categoria_id,
            owner_user_id, created_at)
         VALUES ($1,'pagar',$2,$3,$4,$5,$6::finance_status,$7,$8,$9,$10)`,
        [orgId, d.descricao, money(num(d.faixa[0], d.faixa[1])), dateStr(venc),
          passado ? dateStr(venc) : null, passado ? 'liquidado' : 'pendente',
          d.categoria, categorias.get(d.categoria) ?? null, pick(operacao).id, at(venc, 9)],
      );
    }
  }
  // 3 contas VENCIDAS e em aberto (alerta do dashboard e da tela de Financeiro).
  for (let k = 0; k < 3; k++) {
    const d = D.DESPESAS_VARIAVEIS[k]!;
    await query(
      `INSERT INTO finance_entries
         (org_id, kind, descricao, valor, vencimento, status, categoria, categoria_id, owner_user_id, notas)
       VALUES ($1,'pagar',$2,$3,$4,'pendente',$5,$6,$7,$8)`,
      [orgId, d.descricao, money(num(d.faixa[0], d.faixa[1])), dateStr(cal.hoje - int(4, 26)),
        d.categoria, categorias.get(d.categoria) ?? null, financeiro.id,
        'Aguardando segunda via do boleto.'],
    );
  }
  // Vencendo nos próximos dias.
  for (let k = 0; k < 4; k++) {
    const d = pick(D.DESPESAS_VARIAVEIS);
    await query(
      `INSERT INTO finance_entries
         (org_id, kind, descricao, valor, vencimento, status, categoria, categoria_id, owner_user_id)
       VALUES ($1,'pagar',$2,$3,$4,'pendente',$5,$6,$7)`,
      [orgId, d.descricao, money(num(d.faixa[0], d.faixa[1])), dateStr(cal.hoje + int(1, 6)),
        d.categoria, categorias.get(d.categoria) ?? null, financeiro.id],
    );
  }
  // Únicos registros com o usuário de demonstração como dono, e de propósito.
  // /api/notifications é estritamente por dono (owner_user_id = userId, sem
  // bypass de admin): sem nada no nome dele o sino da demo fica permanentemente
  // vazio, por mais cheio que esteja o dashboard. Contas a vencer são a âncora
  // certa — o alerta dispara o dia inteiro (vencimento entre hoje e amanhã),
  // diferente do de agenda, que só vale na hora seguinte ao compromisso — e
  // financeiro não entra em Carteiras, ranking, metas nem comissões, que é o que
  // a regra "o visitante não é dono de nada" existe para proteger.
  for (let k = 0; k < 3; k++) {
    const d = D.DESPESAS_VARIAVEIS[k]!;
    await query(
      `INSERT INTO finance_entries
         (org_id, kind, descricao, valor, vencimento, status, categoria, categoria_id, owner_user_id)
       VALUES ($1,'pagar',$2,$3,$4,'pendente',$5,$6,$7)`,
      [orgId, d.descricao, money(num(d.faixa[0], d.faixa[1])), dateStr(cal.hoje + (k === 0 ? 0 : 1)),
        d.categoria, categorias.get(d.categoria) ?? null, usuarios[0]!.id],
    );
  }
  // Bonificação a receber (receita que não vem de comissão) — dá conteúdo à
  // aba "a receber" mesmo com as comissões todas liquidadas.
  for (let k = 0; k < 3; k++) {
    const rep = pick(repsAtivas);
    await query(
      `INSERT INTO finance_entries
         (org_id, kind, descricao, valor, vencimento, status, categoria, categoria_id, represented_id, owner_user_id)
       VALUES ($1,'receber',$2,$3,$4,'pendente',$5,$6,$7,$8)`,
      [orgId, `Bonificação trimestral — ${rep.def.nome}`, money(num(1200, 4800)),
        dateStr(cal.hoje + int(3, 25)), 'Bonificações', categorias.get('Bonificações') ?? null,
        rep.id, gerente.id],
    );
  }

  // ---------------------------------------------------------- 8. metas

  // Meta acima do realizado do mês (é meta, não espelho): a tela de Metas e o
  // dashboard mostram atingimento entre ~80% e ~115%.
  const realizado = await query<{ user_id: string; competencia: string; total: string }>(
    `SELECT o.owner_user_id AS user_id, date_trunc('month', o.faturado_em)::date AS competencia,
            SUM(o.total) AS total
       FROM orders o
      WHERE o.org_id = $1 AND o.status IN ('faturado','entregue') AND o.faturado_em IS NOT NULL
      GROUP BY 1, 2`,
    [orgId],
  );
  const realMap = new Map(realizado.map((r) => [`${r.user_id}:${String(r.competencia).slice(0, 10)}`, Number(r.total)]));
  // Só os vendedores têm cota. O dashboard soma TODAS as goals da competência
  // (inclusive as por representada), então meta de quem não vende — o gerente —
  // entraria no denominador sem nunca ter realizado, e o medidor de atingimento
  // marcaria um buraco que não existe na operação.
  for (const v of vendedores) {
    for (let m = 0; m < 6; m++) {
      const comp = dateStr(cal.meses[m]!);
      const feito = realMap.get(`${v.id}:${comp}`) ?? 0;
      // Meta do mês corrente é do MÊS INTEIRO — sai do realizado fechado do mês
      // anterior, não do parcial deste. Derivar do parcial faria a meta encolher
      // junto com o mês e o gráfico "meta vs. realizado" marcaria 100% todo dia.
      const base = m === 5
        ? Math.max(realMap.get(`${v.id}:${dateStr(cal.meses[4]!)}`) ?? 0, 60_000)
        : Math.max(feito, 40_000);
      await query(
        `INSERT INTO goals (org_id, user_id, competencia, valor_meta, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [orgId, v.id, comp, money(base * num(0.9, 1.18)), at(cal.meses[m]!, 9)]);
    }
  }
  // Metas por representada em meses FECHADOS (a tela aceita meta global e por
  // representada). Fora do mês corrente pelo mesmo motivo acima: elas somariam
  // por cima da meta global no dashboard.
  for (const v of vendedores) {
    for (const rep of repsAtivas.slice(0, 3)) {
      for (const mes of [1, 2, 3]) {
        await query(
          `INSERT INTO goals (org_id, user_id, represented_id, competencia, valor_meta)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [orgId, v.id, rep.id, dateStr(cal.meses[mes]!), money(num(12_000, 34_000))]);
      }
    }
  }

  // ---------------------------------------------------------- 9. agenda e amostras

  const atividadesFeitas: { id: number; rel: Relacionamento; owner: Usuario }[] = [];

  // Passado: visitas feitas com check-in real (lat/lon da empresa) e relatório.
  for (let d = cal.meses[0]!; d < cal.hoje; d++) {
    if (isWeekend(d)) continue;
    for (const v of vendedores) {
      for (let k = 0; k < int(0, 2); k++) {
        const rel = pick(rels);
        const hora = int(8, 16);
        const tipo = chance(0.65) ? 'visita' : chance(0.6) ? 'ligacao' : 'tarefa';
        const titulo = tipo === 'visita' ? pick(D.TITULOS_VISITA)
          : tipo === 'ligacao' ? pick(D.TITULOS_LIGACAO) : pick(D.TITULOS_TAREFA);
        // ~12% dos compromissos passados ficam sem baixa — a agenda de verdade
        // tem pendência atrasada, e a tela precisa mostrar isso.
        const feito = !chance(0.12);
        const rel8 = pick(D.RELATORIOS_VISITA);
        const r = await one<{ id: number }>(
          `INSERT INTO activities
             (org_id, tipo, titulo, start_at, end_at, owner_user_id, company_id, represented_id, contact_id,
              status, checkin_lat, checkin_lon, checkin_at, relatorio)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::activity_status,$11,$12,$13,$14)
           RETURNING id`,
          [orgId, tipo, `${titulo} — ${rel.empresa.nome}`, at(d, hora), at(d, hora + 1), v.id,
            rel.empresa.id, rel.representada.id, rel.contatos[0] ?? null,
            feito ? 'feito' : 'pendente',
            feito && tipo === 'visita' ? rel.empresa.lat + num(-0.0008, 0.0008) : null,
            feito && tipo === 'visita' ? rel.empresa.lon + num(-0.0008, 0.0008) : null,
            feito && tipo === 'visita' ? at(d, hora, int(0, 20)) : null,
            feito ? JSON.stringify({ resultado: rel8.resultado, proximo_passo: rel8.proximo, texto: rel8.texto }) : null],
        );
        if (feito) atividadesFeitas.push({ id: Number(r!.id), rel, owner: v });
      }
    }
  }

  // Hoje: 3-5 compromissos pendentes (o dashboard tem um bloco só para isso).
  for (let k = 0; k < int(3, 5); k++) {
    const rel = pick(rels);
    const v = pick(vendedores);
    const hora = 8 + k * 2;
    await query(
      `INSERT INTO activities (org_id, tipo, titulo, start_at, end_at, owner_user_id, company_id, represented_id, contact_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendente')`,
      [orgId, chance(0.7) ? 'visita' : 'ligacao', `${pick(D.TITULOS_VISITA)} — ${rel.empresa.nome}`,
        at(cal.hoje, hora), at(cal.hoje, hora + 1), v.id, rel.empresa.id, rel.representada.id,
        rel.contatos[0] ?? null]);
  }

  // Futuro: 14 dias de agenda + uma série semanal (mesma visita toda terça).
  for (let d = cal.hoje + 1; d <= cal.hoje + 14; d++) {
    if (isWeekend(d)) continue;
    for (const v of vendedores) {
      for (let k = 0; k < int(0, 2); k++) {
        const rel = pick(rels);
        const hora = int(8, 16);
        await query(
          `INSERT INTO activities (org_id, tipo, titulo, start_at, end_at, owner_user_id, company_id, represented_id, contact_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendente')`,
          [orgId, chance(0.6) ? 'visita' : chance(0.5) ? 'ligacao' : 'tarefa',
            `${pick(D.TITULOS_VISITA)} — ${rel.empresa.nome}`, at(d, hora), at(d, hora + 1),
            v.id, rel.empresa.id, rel.representada.id, rel.contatos[0] ?? null]);
      }
    }
  }
  // Série semanal: reunião fixa de terça, 8 semanas (4 passadas, 4 futuras).
  const terca = cal.hoje - ((weekday(cal.hoje) + 5) % 7) - 28;
  for (let s = 0; s < 8; s++) {
    const d = terca + s * 7;
    await query(
      `INSERT INTO activities (org_id, tipo, titulo, start_at, end_at, owner_user_id, status)
       VALUES ($1,'tarefa','Reunião semanal de carteira',$2,$3,$4,$5::activity_status)`,
      [orgId, at(d, 8, 30), at(d, 9, 30), gerente.id, d < cal.hoje ? 'feito' : 'pendente']);
  }

  // Amostras: crítico no alimentício (degustação antes de fechar).
  for (let k = 0; k < 25; k++) {
    const rel = pick(rels);
    const item = pick(rel.representada.itens);
    const solicitada = cal.hoje - int(0, 120);
    const status = solicitada < cal.hoje - 40 ? pick(['recebida', 'recebida', 'cancelada'])
      : solicitada < cal.hoje - 12 ? pick(['enviada', 'recebida']) : 'solicitada';
    await query(
      `INSERT INTO sample_requests
         (org_id, relationship_id, catalog_item_id, produto_snapshot, contact_id, owner_user_id,
          status, quantidade, data_solicitacao, data_prevista, notas, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::sample_status,$8,$9,$10,$11,$12,$12)`,
      [orgId, rel.id, item.id, item.def.nome, rel.contatos[0] ?? null, rel.owner?.id ?? pick(vendedores).id,
        status, int(1, 6), dateStr(solicitada), dateStr(solicitada + int(3, 12)),
        chance(0.5) ? 'Degustação com a equipe da loja antes de fechar o mix.' : null,
        at(solicitada, 10)],
    );
  }

  // ---------------------------------------------------------- 10. rotas

  // Roteiro semanal por vendedor: 6-10 paradas na mesma região, saindo do
  // escritório. Distância por perna calculada em linha reta com fator de malha
  // viária (1,35) — sem chamar o OSRM, que é serviço externo.
  const haversine = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number => {
    const R = 6371, toRad = (x: number): number => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const criarRota = async (
    nome: string, dia: number, owner: Usuario, veiculoIdx: number,
    paradas: Empresa[], template: boolean, recorrencia: string | null,
  ): Promise<number> => {
    const v = D.VEICULOS[veiculoIdx]!;
    const origem = { lat: orgCidade.lat, lon: orgCidade.lon };
    let dist = 0;
    const coords: [number, number][] = [[origem.lat, origem.lon]];
    const legs: { km: number; min: number }[] = [];
    let anterior: { lat: number; lon: number } = origem;
    for (const p of paradas) {
      const km = haversine(anterior, p) * 1.35;
      dist += km;
      legs.push({ km, min: (km / 45) * 60 });
      coords.push([p.lat, p.lon]);
      anterior = p;
    }
    dist += haversine(anterior, origem) * 1.35; // volta ao escritório
    coords.push([origem.lat, origem.lon]);
    const dur = (dist / 45) * 60 + paradas.length * 25; // 45 km/h médios + 25 min por parada
    const fuel = fuelEstimate({ distKm: dist, consumoKml: v.consumo, precoLitro: v.preco });

    const r = await one<{ id: number }>(
      `INSERT INTO routes
         (org_id, vehicle_id, nome, origem_lat, origem_lon, dist_km, dur_min, preco_litro, litros,
          custo_total, geometry, owner_user_id, template, recorrencia, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [orgId, veiculos[veiculoIdx], nome, origem.lat, origem.lon,
        dist.toFixed(2), dur.toFixed(1), v.preco, fuel?.litros.toFixed(2) ?? null,
        fuel?.custo != null ? fuel.custo.toFixed(2) : null,
        JSON.stringify({ coordinates: coords }), owner.id, template, recorrencia, at(dia, 7, 30)],
    );
    const rid = Number(r!.id);
    for (let i = 0; i < paradas.length; i++) {
      await query(
        `INSERT INTO route_stops (route_id, company_id, seq, lat, lon, leg_dist_km, leg_dur_min)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [rid, paradas[i]!.id, i + 1, paradas[i]!.lat, paradas[i]!.lon,
          legs[i]!.km.toFixed(2), legs[i]!.min.toFixed(1)]);
    }
    return rid;
  };

  // Rotas rodadas: uma por vendedor por semana nas últimas 12 semanas.
  for (let semana = 0; semana < 12; semana++) {
    for (let vi = 0; vi < vendedores.length; vi++) {
      const dia = nextWeekday(cal.hoje - (semana * 7) - int(0, 4));
      if (dia >= cal.hoje) continue;
      const cidade = weighted(D.CIDADES);
      const naCidade = empresas.filter((e) => e.cidade.id === cidade.id);
      if (naCidade.length < 6) continue;
      const paradas = shuffled(naCidade).slice(0, int(6, Math.min(10, naCidade.length)));
      const rotaId = await criarRota(
        `Roteiro ${cidade.nome} — ${dateStr(dia).split('-').reverse().slice(0, 2).join('/')}`,
        dia, vendedores[vi]!, vi + 1, paradas, false, null,
      );
      // Combustível da rota lançado no financeiro (a tela liga despesa ↔ rota).
      if (chance(0.5)) {
        await query(
          `INSERT INTO finance_entries
             (org_id, kind, descricao, valor, vencimento, liquidacao_data, status, categoria, categoria_id,
              owner_user_id, route_id)
           VALUES ($1,'pagar',$2,$3,$4,$4,'liquidado','Combustível',$5,$6,$7)`,
          [orgId, `Combustível — roteiro ${cidade.nome}`, money(num(120, 380)), dateStr(dia),
            categorias.get('Combustível') ?? null, vendedores[vi]!.id, rotaId]);
        }
    }
  }
  // Template recorrente: o roteiro fixo de terça-feira em Campinas.
  {
    const naCidade = empresas.filter((e) => e.cidade.id === orgCidade.id);
    await criarRota('Roteiro fixo — Campinas (terças)', cal.hoje, gerente,
      0, shuffled(naCidade).slice(0, 8), true, 'semanal');
  }

  // ---------------------------------------------------------- 11. e-mail

  const templates: number[] = [];
  for (const t of D.EMAIL_TEMPLATES) {
    const r = await one<{ id: number }>(
      `INSERT INTO email_templates (org_id, nome, assunto, corpo, owner_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [orgId, t.nome, t.assunto, t.corpo, gerente.id, at(cal.meses[0]!, 10)]);
    templates.push(Number(r!.id));
  }

  const preencher = (s: string, rel: Relacionamento, v: Usuario): string => s
    .replace(/\{\{empresa\}\}/g, rel.empresa.nome)
    .replace(/\{\{contato\}\}/g, 'time de compras')
    .replace(/\{\{representada\}\}/g, rel.representada.def.nome)
    .replace(/\{\{vendedor\}\}/g, v.nome);

  // Passado: já enviados (o scheduler nunca deve encontrar pendente vencido, §2).
  for (let k = 0; k < 22; k++) {
    const rel = pick(rels);
    const v = pick(vendedores);
    const ti = int(0, D.EMAIL_TEMPLATES.length - 1);
    const t = D.EMAIL_TEMPLATES[ti]!;
    const quando = cal.hoje - int(2, 120);
    await query(
      `INSERT INTO email_schedules
         (org_id, template_id, company_id, remetente, destinatario, assunto, corpo, agendado_para,
          status, enviado_em, owner_user_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'enviado',$8,$9,$10,$8)`,
      [orgId, templates[ti], rel.empresa.id, 'contato@saborecia.com.br',
        `contato@${rel.empresa.nome.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.com.br`,
        preencher(t.assunto, rel, v), preencher(t.corpo, rel, v), businessAt(quando), v.id, at(quando - 1, 16)],
    );
  }
  // Um erro de envio — a tela tem coluna de erro e o visitante precisa vê-la.
  {
    const rel = pick(rels);
    const v = pick(vendedores);
    const t = D.EMAIL_TEMPLATES[2]!;
    await query(
      `INSERT INTO email_schedules
         (org_id, template_id, company_id, remetente, destinatario, assunto, corpo, agendado_para,
          status, erro, owner_user_id)
       VALUES ($1,$2,$3,'contato@saborecia.com.br',$4,$5,$6,$7,'erro',$8,$9)`,
      [orgId, templates[2], rel.empresa.id, 'compras@enderecoinvalido', preencher(t.assunto, rel, v),
        preencher(t.corpo, rel, v), businessAt(cal.hoje - 9),
        '550 5.1.1 recipient rejected: domínio inexistente', v.id]);
  }
  // Futuro: pendentes (o scheduler não dispara nada — SMTP desligado nesta org).
  for (let k = 0; k < 6; k++) {
    const rel = pick(rels);
    const v = pick(vendedores);
    const ti = int(0, D.EMAIL_TEMPLATES.length - 1);
    const t = D.EMAIL_TEMPLATES[ti]!;
    await query(
      `INSERT INTO email_schedules
         (org_id, template_id, company_id, remetente, destinatario, assunto, corpo, agendado_para,
          status, owner_user_id)
       VALUES ($1,$2,$3,'contato@saborecia.com.br',$4,$5,$6,$7,'pendente',$8)`,
      [orgId, templates[ti], rel.empresa.id,
        `contato@${rel.empresa.nome.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.com.br`,
        preencher(t.assunto, rel, v), preencher(t.corpo, rel, v),
        at(nextWeekday(cal.hoje + int(1, 18)), int(8, 16)), v.id]);
  }

  // ---------------------------------------------------------- 12. WhatsApp

  const numeroOrg = `55${telefoneCel('19')}`;
  await query(
    `INSERT INTO org_whatsapp_settings (org_id, instance_name, numero, status, include_sender_name)
     VALUES ($1,$2,$3,'conectado',true)`,
    [orgId, `org_${orgId}`, numeroOrg],
  );

  await semearWhatsapp(orgId, cal, rels, vendedores, repsAtivas);

  // ---------------------------------------------------------- 13. auditoria

  // Trilha dos últimos 30 dias, com vários atores — é o que a tela de Logs lê.
  for (let k = 0; k < 150; k++) {
    const ev = pick(D.AUDIT_EVENTOS);
    const ator = pick([...operacao, financeiro, usuarios[0]!]);
    const quando = cal.hoje - int(0, 29);
    await query(
      'INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, diff, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [orgId, ator.id, ev.entity, pick(pedidoIds), ev.action, JSON.stringify(ev.diff), businessAt(quando)]);
  }

  // Notificações NÃO são semeadas de propósito: /api/notifications recalcula os
  // alertas a cada leitura (vencimento, agenda, comissão, negócio parado) e apaga
  // o que não bate. Semear geraria linhas que o primeiro acesso já descartaria —
  // os alertas nascem sozinhos dos dados acima.

  return { orgId, contagens: await contar(orgId) };
}

// Contagem lida do banco (e não de contadores em JS): é o número que o app vai
// enxergar, incluindo o que veio de createCommissionForOrder e do materializador
// de recorrências, que o seed não conta linha a linha.
const TABELAS_TENANT = [
  'users', 'permission_groups', 'stages', 'funnel_scenarios', 'funnel_actions',
  'represented_companies', 'represented_brands', 'catalog_items', 'price_tables',
  'company_relationships', 'contacts', 'private_labels', 'vehicles', 'carriers',
  'orders', 'commission_rules', 'commission_entries', 'finance_categories', 'finance_entries',
  'goals', 'activities', 'sample_requests', 'routes', 'email_templates', 'email_schedules',
  'whatsapp_chats', 'whatsapp_messages', 'whatsapp_schedules', 'audit_log',
] as const;

async function contar(orgId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = { organizations: 1 };
  for (const t of TABELAS_TENANT) {
    const r = await one<{ n: string }>(`SELECT count(*)::int AS n FROM ${t} WHERE org_id = $1`, [orgId]);
    out[t] = Number(r!.n);
  }
  // Tabelas sem org_id próprio: escopadas pelo pai.
  for (const [nome, sql] of [
    ['companies (demo)', "SELECT count(*)::int AS n FROM companies WHERE source = 'demo'"],
    ['price_table_items', 'SELECT count(*)::int AS n FROM price_table_items i JOIN price_tables t ON t.id = i.price_table_id WHERE t.org_id = $1'],
    ['order_items', 'SELECT count(*)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.org_id = $1'],
    ['route_stops', 'SELECT count(*)::int AS n FROM route_stops s JOIN routes r ON r.id = s.route_id WHERE r.org_id = $1'],
    ['commissions recebidas', "SELECT count(*)::int AS n FROM commission_entries WHERE org_id = $1 AND status IN ('recebida','divergente')"],
    ['finance vencidas em aberto', "SELECT count(*)::int AS n FROM finance_entries WHERE org_id = $1 AND status = 'pendente' AND vencimento < current_date"],
  ] as const) {
    const r = await one<{ n: string }>(sql, sql.includes('$1') ? [orgId] : []);
    out[nome] = Number(r!.n);
  }
  return out;
}

// Faixa de ticket do perfil da empresa — usada no valor estimado do funil.
const perfil0 = (e: Empresa): number => e.perfil.ticket[0];
const perfil1 = (e: Empresa): number => e.perfil.ticket[1];

// Dia útil dentro do mês: se rolar para além do fim da janela, volta.
function nextWeekdayDentro(day: number, limite: number): number {
  let d = day;
  while (isWeekend(d) && d < limite) d++;
  while (isWeekend(d) && d > 0) d--;
  return Math.min(d, limite);
}

// ------------------------------------------------------------------ WhatsApp

async function semearWhatsapp(
  orgId: number,
  cal: Calendario,
  rels: Relacionamento[],
  vendedores: Usuario[],
  reps: Representada[],
): Promise<void> {
  // Grava a mídia onde o app for lê-la: volume em disco quando WHATSAPP_MEDIA_DIR
  // está setado (VPS), base64 na linha caso contrário. Mesmo caminho de código do
  // recebimento real — nada de formato especial de demo.
  const gravarMidia = async (
    msgId: string, buf: Buffer, mime: string, fileName: string,
  ): Promise<void> => {
    if (mediaEnabled()) {
      const rel = await saveMedia(orgId, msgId, buf.toString('base64'), mime, fileName);
      await query('UPDATE whatsapp_messages SET media_path = $2 WHERE id = $1', [msgId, rel]);
    } else {
      await query('UPDATE whatsapp_messages SET media_b64 = $2 WHERE id = $1', [msgId, buf.toString('base64')]);
    }
  };

  const clientes = shuffled(rels.filter((r) => r.status === 'cliente' && r.contatos.length > 0));
  const roteiros = shuffled(D.ROTEIROS);

  interface PlanoChat {
    roteiro: D.DemoRoteiro; rel: Relacionamento | null; grupo: string | null;
    naoLidas: number; comLid: boolean;
  }
  const planos: PlanoChat[] = [];
  // 12 conversas vinculadas ao funil, 3 números soltos, 2 grupos, 1 com merge de
  // LID (§8). O total é o que a tela de WhatsApp precisa para exercitar todos os
  // caminhos: rótulo de cliente, botão de vincular, grupo e conciliação de jid.
  for (let i = 0; i < 12; i++) {
    planos.push({ roteiro: roteiros[i % roteiros.length]!, rel: clientes[i] ?? null, grupo: null, naoLidas: 0, comLid: i === 3 });
  }
  for (let i = 0; i < 3; i++) {
    planos.push({ roteiro: roteiros[(12 + i) % roteiros.length]!, rel: null, grupo: null, naoLidas: 0, comLid: false });
  }
  for (let i = 0; i < D.GRUPOS_WA.length; i++) {
    planos.push({ roteiro: roteiros[(15 + i) % roteiros.length]!, rel: null, grupo: D.GRUPOS_WA[i]!, naoLidas: 0, comLid: false });
  }
  planos.push({ roteiro: roteiros[17 % roteiros.length]!, rel: clientes[12] ?? null, grupo: null, naoLidas: 0, comLid: false });
  // 4 conversas com não-lidas (badge na lateral e no menu).
  for (const i of [0, 2, 5, 13]) if (planos[i]) planos[i]!.naoLidas = int(1, 6);

  const chatIds: number[] = [];

  for (let ci = 0; ci < planos.length; ci++) {
    const p = planos[ci]!;
    const ddd = p.rel?.empresa.cidade.ddd ?? '19';
    const numero = `55${telefoneCel(ddd)}`;
    const jid = p.grupo ? `12036300${String(1000 + ci)}@g.us` : `${numero}@s.whatsapp.net`;
    const nome = p.grupo ?? p.rel?.empresa.nome ?? pick(['Comprador — indicação', 'Novo contato', 'Lanchonete do Chapadão']);

    // Roteiro: a conversa termina "agora" e caminha para trás. Assim toda demo
    // abre com mensagem recente, independente do dia em que rodou o seed.
    const pares = p.roteiro.msgs;
    const historico: D.DemoMsg[] = [];
    for (let h = 0; h < int(6, 12); h++) historico.push(...pick(D.HISTORICO_PARES));
    const linha = [...historico, ...pares];

    // Intervalo entre mensagens: o do roteiro quando existe, sorteado quando não.
    // Sorteado UMA vez (e não em cada leitura), senão o total usado para ancorar o
    // início da conversa não bate com o que o laço realmente consome.
    const gaps = linha.map((m) => m.min ?? int(4, 40));
    const totalMin = gaps.reduce((s, g) => s + g, 0);
    const fimMin = int(30, 60 * 26); // termina entre 30 min e ~1 dia atrás
    let cursor = cal.hoje * 1440 + 17 * 60 - fimMin - totalMin;
    // Empurra o início para dentro dos últimos 30 dias, no horário comercial.
    cursor = Math.max(cursor, (cal.hoje - 29) * 1440 + 9 * 60);

    const chat = await one<{ id: number }>(
      `INSERT INTO whatsapp_chats (org_id, remote_jid, numero, nome, company_id, relationship_id, contact_id, nao_lidas, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, jid, p.grupo ? null : numero, nome, p.rel?.empresa.id ?? null, p.rel?.id ?? null,
        p.rel?.contatos[0] ?? null, p.naoLidas, at(cal.hoje - int(30, 120), 9)],
    );
    const chatId = Number(chat!.id);
    chatIds.push(chatId);

    await query(
      `INSERT INTO whatsapp_chat_jids (org_id, jid, chat_id, tipo) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [orgId, jid, chatId, p.grupo ? 'group' : 'phone']);
    if (p.comLid) {
      // Conversa que já passou pela conciliação de @lid: o alias aponta para o
      // mesmo chat, exercitando o caminho de merge sem precisar da Evolution.
      const lid = `${int(100000000000, 999999999999)}@lid`;
      await query(
        'INSERT INTO whatsapp_chat_jids (org_id, jid, chat_id, tipo) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [orgId, lid, chatId, 'lid']);
      await query('UPDATE whatsapp_chats SET lid = $2 WHERE id = $1', [chatId, lid]);
    }

    // Avatar servido pelo cache local (nunca sai para o CDN da Meta).
    const iniciais = nome.replace(/[^A-Za-zÀ-ú ]/g, '').split(' ').filter(Boolean).slice(0, 2)
      .map((w) => w[0]!).join('') || 'WA';
    const av = avatar(iniciais, ci);
    if (mediaEnabled()) {
      const rel = await saveAvatar(orgId, String(chatId), av, 'image/png');
      await query('UPDATE whatsapp_chats SET foto_path = $2, foto_mime = $3, foto_at = now() WHERE id = $1',
        [chatId, rel, 'image/png']);
    } else {
      await query('UPDATE whatsapp_chats SET foto_b64 = $2, foto_mime = $3, foto_at = now() WHERE id = $1',
        [chatId, av.toString('base64'), 'image/png']);
    }

    const idsDoRoteiro: number[] = [];
    let ultimoTexto = '', ultimoMomento = '';
    for (let mi = 0; mi < linha.length; mi++) {
      const m = linha[mi]!;
      cursor += gaps[mi]!;
      // Fora do horário comercial a conversa "dorme" até as 8h do dia seguinte.
      const hora = Math.floor((cursor % 1440) / 60);
      if (hora >= 20) cursor = (Math.floor(cursor / 1440) + 1) * 1440 + 8 * 60 + int(0, 90);
      else if (hora < 7) cursor = Math.floor(cursor / 1440) * 1440 + 8 * 60 + int(0, 90);
      const dia = Math.floor(cursor / 1440);
      const momento = at(dia, Math.floor((cursor % 1440) / 60), cursor % 60);

      const fromMe = m.me === true || m.nota === true;
      const tipo = m.midia === 'foto' ? 'imagem' : m.midia === 'pdf' ? 'documento'
        : m.midia === 'audio' ? 'audio' : 'texto';
      // Outbound com o autor preenchido: a UI mostra quem atendeu (include_sender_name).
      const sender = fromMe ? pick(vendedores) : null;
      const respIdx = m.resp !== undefined ? idsDoRoteiro[historico.length + m.resp] : undefined;

      const r = await one<{ id: string }>(
        `INSERT INTO whatsapp_messages
           (org_id, chat_id, evolution_id, from_me, tipo, corpo, status, momento, mime, file_name,
            sender_user_id, internal, reply_to_id)
         VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [orgId, chatId, fromMe, tipo, m.t ?? null,
          // Tique só nas mensagens que saíram; inbound não tem status.
          fromMe && !m.nota ? pick(['enviado', 'entregue', 'entregue', 'lido', 'lido']) : null,
          momento,
          m.midia === 'foto' ? 'image/png' : m.midia === 'pdf' ? 'application/pdf'
            : m.midia === 'audio' ? 'audio/wav' : null,
          m.arquivo ?? null, sender?.id ?? null, m.nota === true, respIdx ?? null],
      );
      const msgId = String(r!.id);
      idsDoRoteiro.push(Number(msgId));

      if (m.midia === 'foto') {
        await gravarMidia(msgId, fotoGondola(ci), 'image/png', m.arquivo ?? 'foto.png');
      } else if (m.midia === 'pdf') {
        const rep = p.rel?.representada ?? pick(reps);
        await gravarMidia(msgId, pdfTabela(
          m.t ?? 'Tabela vigente',
          `${rep.def.nome} · vigência a partir de ${dateStr(cal.meses[0]!).split('-').reverse().join('/')}`,
          rep.itens.slice(0, 12).map((it) => [it.def.nome, `R$ ${it.def.preco.toFixed(2).replace('.', ',')}`]),
        ), 'application/pdf', m.arquivo ?? 'tabela.pdf');
      } else if (m.midia === 'audio') {
        await gravarMidia(msgId, wavNota(2.4, 220), 'audio/wav', m.arquivo ?? 'audio.wav');
      }

      // A prévia da lateral é a última mensagem que NÃO é nota interna.
      if (!m.nota) {
        ultimoTexto = m.t ?? (tipo === 'imagem' ? '📷 Imagem' : tipo === 'audio' ? '🎧 Áudio' : '📎 Documento');
        ultimoMomento = momento;
      }
    }
    await query(
      'UPDATE whatsapp_chats SET last_message_at = $2, last_preview = $3 WHERE id = $1',
      [chatId, ultimoMomento, ultimoTexto.slice(0, 120)]);
  }

  // Agendamentos: 3 pendentes no futuro (um recorrente semanal com serie_id),
  // 2 enviados no passado e 1 com erro. Com o curto-circuito de org demo, quando
  // os pendentes vencerem o scheduler grava local — nada sai (docs §8).
  const serie = randomUUID();
  for (let s = 0; s < 3; s++) {
    const chatId = chatIds[s]!;
    const jid = (await one<{ remote_jid: string }>(
      'SELECT remote_jid FROM whatsapp_chats WHERE id = $1', [chatId]))!.remote_jid;
    const semanal = s > 0;
    await query(
      `INSERT INTO whatsapp_schedules
         (org_id, chat_id, remote_jid, corpo, agendado_para, status, owner_user_id, recorrencia, serie_id)
       VALUES ($1,$2,$3,$4,$5,'pendente',$6,$7,$8)`,
      [orgId, chatId, jid,
        semanal ? 'Bom dia! Fechando o pedido programado da semana — mantém a mesma grade?'
          : 'Oi! Passando para confirmar a visita de amanhã às 9h.',
        at(nextWeekday(cal.hoje + 1 + s * 7), 8, 30),
        pick(vendedores).id, semanal ? 'semanal' : null, semanal ? serie : null]);
  }
  for (let s = 0; s < 2; s++) {
    const chatId = chatIds[5 + s]!;
    const jid = (await one<{ remote_jid: string }>(
      'SELECT remote_jid FROM whatsapp_chats WHERE id = $1', [chatId]))!.remote_jid;
    const quando = businessAt(cal.hoje - int(3, 20));
    await query(
      `INSERT INTO whatsapp_schedules
         (org_id, chat_id, remote_jid, corpo, agendado_para, status, enviado_em, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,'enviado',$5,$6)`,
      [orgId, chatId, jid, 'Bom dia! Seu boleto vence hoje, qualquer coisa me chama.', quando,
        pick(vendedores).id]);
  }
  {
    const chatId = chatIds[7]!;
    const jid = (await one<{ remote_jid: string }>(
      'SELECT remote_jid FROM whatsapp_chats WHERE id = $1', [chatId]))!.remote_jid;
    await query(
      `INSERT INTO whatsapp_schedules
         (org_id, chat_id, remote_jid, corpo, agendado_para, status, erro, owner_user_id)
       VALUES ($1,$2,$3,$4,$5,'erro',$6,$7)`,
      [orgId, chatId, jid, 'Segue a tabela nova em anexo.', businessAt(cal.hoje - 6),
        'número não encontrado no WhatsApp', pick(vendedores).id]);
  }

}

// ------------------------------------------------------------------ reset

// Apaga a org de demo. Cascata cobre as tabelas do tenant; as empresas fictícias
// vivem no pool global e saem depois (a FK company_relationships → companies não
// tem ON DELETE, então a ordem importa). Nunca TRUNCATE: em produção isso
// derrubaria as orgs reais junto.
async function deleteDemo(orgId: number): Promise<void> {
  if (mediaEnabled()) {
    await rm(join(config.whatsappMediaDir, String(orgId)), { recursive: true, force: true }).catch(() => {});
  }
  await query('DELETE FROM organizations WHERE id = $1', [orgId]);
  await query("DELETE FROM companies WHERE source = 'demo' AND NOT EXISTS ("
    + 'SELECT 1 FROM company_relationships r WHERE r.company_id = companies.id)');
}

async function resetDemo(nome: string): Promise<number> {
  const orgs = await query<{ id: number }>(
    'SELECT id FROM organizations WHERE demo = true AND nome = $1', [nome]);
  for (const o of orgs) await deleteDemo(Number(o.id));
  // Empresas 'demo' órfãs de execuções anteriores interrompidas.
  await query("DELETE FROM companies WHERE source = 'demo' AND NOT EXISTS ("
    + 'SELECT 1 FROM company_relationships r WHERE r.company_id = companies.id)');
  return orgs.length;
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const existente = await one<{ id: number; nome: string; demo: boolean }>(
    'SELECT id, nome, demo FROM organizations WHERE nome = $1', [flags.org]);
  if (existente && !existente.demo) {
    throw new Error(`já existe uma organização NÃO-demo chamada "${flags.org}" (id ${existente.id}) — escolha outro --org`);
  }
  if (existente && !flags.reset && !flags.dryRun) {
    throw new Error(`a org de demo "${flags.org}" já existe (id ${existente.id}) — use --reset para recriar`);
  }
  // O e-mail de login é UNIQUE global: se estiver preso em outra org, o seed
  // falharia no meio. Melhor recusar antes de escrever qualquer coisa.
  const dono = await one<{ org_id: number }>(
    'SELECT org_id FROM users WHERE email = $1', ['adm@rovvatech.com.br']);
  if (dono && (!existente || Number(dono.org_id) !== Number(existente.id))) {
    throw new Error('o e-mail adm@rovvatech.com.br já pertence a outra organização — libere-o antes de semear');
  }

  if (flags.reset || flags.dryRun) {
    const n = await resetDemo(flags.org);
    if (n) console.log(`reset  ${n} org(s) de demo removida(s)`);
  }

  const t0 = process.hrtime.bigint();
  let orgId = 0;
  try {
    const r = await seed(flags);
    orgId = r.orgId;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    console.log(`\norg de demonstração "${flags.org}" (id ${orgId}) — semente ${flags.seed}\n`);
    const largura = Math.max(...Object.keys(r.contagens).map((k) => k.length));
    for (const [k, v] of Object.entries(r.contagens)) {
      console.log(`  ${k.padEnd(largura)}  ${String(v).padStart(6)}`);
    }
    console.log(`\nconcluído em ${(ms / 1000).toFixed(1)}s`);

    if (flags.dryRun) {
      await deleteDemo(orgId);
      console.log('dry-run: org removida, nada persistido');
    } else {
      console.log(`login: adm@rovvatech.com.br · senha ${process.env.DEMO_PASSWORD ? 'de DEMO_PASSWORD' : 'demo123'}`);
    }
  } catch (e) {
    // Substituto da transação única: o que ficou pela metade é apagado, então
    // uma execução que falhou não deixa org meio semeada no ar.
    if (orgId) await deleteDemo(orgId).catch(() => {});
    else {
      const parcial = await one<{ id: number }>(
        'SELECT id FROM organizations WHERE demo = true AND nome = $1', [flags.org]);
      if (parcial) await deleteDemo(Number(parcial.id)).catch(() => {});
    }
    throw e;
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    if (e instanceof Error && e.stack) console.error(e.stack);
    await pool.end().catch(() => {});
    process.exit(1);
  });
