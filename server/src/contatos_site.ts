// Raspagem de contatos na página da própria empresa.
//
// NADA daqui é persistido. O resultado vai para a tela, o representante escolhe
// quais linhas viram contato e só essas entram no banco pelo POST /api/contacts
// de sempre. O único dado que a descoberta grava é o site em si, e quem grava é
// enriquecimento.ts (company_dominio) — não este módulo.
//
// Sem parser de DOM (o servidor não tem dependência de HTML) e sem navegador
// headless. O HTML é linearizado em linhas de texto, com os links de contato
// (mailto:/tel:/wa.me) convertidos em marcadores inline, e os valores são
// agrupados por VIZINHANÇA nessa linearização. É o que torna a raspagem genérica:
// não depende de classe CSS, de CMS nem de dado estruturado — depende só de que
// o rótulo fique perto do valor, que é como página de contato é escrita em
// qualquer site. Medido em coocam.com.br: 1 e-mail na home, 21 em /contato.
import { buscarPagina } from './site.ts';

export interface ContatoSite {
  nome: string | null;      // 'Silvio Zanon'        (null em contato institucional)
  cargo: string | null;     // 'Gerente'
  rotulo: string | null;    // 'Departamento Técnico' / 'Comercialização Insumos'
  email: string | null;
  telefone: string | null;  // só dígitos, DDD + número, sem o 55
  whatsapp: string | null;  // idem; separado porque abre conversa, não liga
  origem: string;           // página exata onde apareceu
}

export interface BuscaContatos {
  contatos: ContatoSite[];
  paginas: string[];        // páginas efetivamente lidas, para a tela justificar o vazio
  // O site respondeu, mas barrando robô (401/403/429). Lista vazia aqui NÃO
  // significa "site sem contato": significa que não deu para ler. A colcci.com.br
  // devolve 403 com uma página de WAF; dizer "nada publicado" seria mentira.
  bloqueado: boolean;
}

// Teto de páginas e prazo total: a rota é síncrona e o usuário está olhando um
// spinner. 6 páginas cobrem home + contato + unidades + sobra; o prazo corta
// site lento antes que a request vire timeout do navegador.
const MAX_PAGINAS = 6;
const PRAZO_MS = 20_000;
const MAX_CONTATOS = 60;

// Páginas que valem visitar. Casa contra o CAMINHO da URL, não contra o texto do
// link: '/fale-conosco' é estável, "Fale conosco" muda com o idioma e o capricho.
const RE_PAGINA_CONTATO =
  /(contato|contact|fale[-_]?conosco|faleconosco|atendimento|quem[-_]?somos|sobre|empresa|institucional|unidades|lojas|filiais|equipe|time|onde[-_]?estamos)/i;
// Tentados quando o site não linka a página de contato no menu (frame, JS, ou
// menu só em imagem). Ordem = probabilidade no mercado brasileiro.
const CAMINHOS_COMUNS = [
  '/contato', '/fale-conosco', '/contatos', '/atendimento',
  '/quem-somos', '/sobre', '/unidades', '/contact',
];
const ARQUIVO = /\.(pdf|jpe?g|png|gif|svg|webp|zip|rar|docx?|xlsx?|pptx?|mp4)$/i;

const hostBase = (h: string): string => h.replace(/^www\./i, '').toLowerCase();

const ENTIDADES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', hellip: '…', bull: '·', middot: '·',
};

function entidades(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, c: string) => {
    if (c.startsWith('#')) {
      const cod = /^#x/i.test(c) ? parseInt(c.slice(2), 16) : Number(c.slice(1));
      // fromCodePoint lança em código fora da faixa Unicode — daí a checagem.
      return Number.isInteger(cod) && cod > 0 && cod < 0x110000 ? String.fromCodePoint(cod) : m;
    }
    return ENTIDADES[c.toLowerCase()] ?? m;
  });
}

// Delimitador dos marcadores. Caractere de controle: some do HTML real (é
// removido logo na entrada) e não colide com nada que o site possa escrever.
const M = '\u0001';
const RE_TOKEN = new RegExp(`${M}([ETW]):(.*?)${M}`, 'g');

// Tags que separam blocos viram quebra de linha; o resto vira espaço. <span>,
// <strong> e afins ficam de fora de propósito: quebrar neles separaria
// "Email:" do endereço que vem logo em seguida dentro do mesmo parágrafo.
const RE_BLOCO =
  /<(?:br|\/?(?:p|div|li|tr|td|th|h[1-6]|section|article|header|footer|nav|aside|ul|ol|dl|dt|dd|table|form|label|address|figcaption|blockquote|main))\b[^>]*>/gi;

// Converte o HTML numa lista de linhas de texto, com os links de contato já
// marcados. Remove antes: comentários (site comentado não é contato publicado),
// script/style (JSON de configuração cheio de e-mail de serviço) e o <head>
// (onde mora o <link rel="author"> da agência que fez o site — foi de lá que
// saiu o "5555555555" na medição da coocam).
export function linearizar(html: string): string[] {
  let s = html
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');

  s = s
    .replace(/<a\b[^>]*\bhref=["']\s*mailto:([^"'?>]+)[^>]*>/gi, (_m, v: string) => ` ${M}E:${v}${M} `)
    .replace(/<a\b[^>]*\bhref=["']\s*tel:([^"'?>]+)[^>]*>/gi, (_m, v: string) => ` ${M}T:${v}${M} `)
    .replace(
      /<a\b[^>]*\bhref=["'][^"']*(?:wa\.me|whatsapp\.com)\/[^"']*?([\d+][\d+%\s.-]{7,})["'][^>]*>/gi,
      (_m, v: string) => ` ${M}W:${v}${M} `,
    );

  return entidades(s.replace(RE_BLOCO, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\u00a0\r\f\v]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

// E-mail que não é contato de ninguém: arquivo com @ no nome ('logo@2x.png'),
// domínio de serviço embutido pelo tema e placeholder de template.
const EMAIL_ARQUIVO = /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|woff2?)$/i;
const EMAIL_DOMINIO_LIXO =
  /(^|\.)(sentry\.io|sentry-cdn\.com|wixpress\.com|example\.(com|org|net)|dominio\.com(\.br)?|seudominio\.com(\.br)?|teste\.com(\.br)?|localhost)$/i;
const EMAIL_LOCAL_LIXO =
  /^(seu-?e?-?mail|e-?mail|exemplo|teste|test|nome|user|username|no-?reply|nao-?responda|postmaster|abuse|webmaster|hostmaster|sentry)$/i;

export function normalizarEmail(bruto: string): string | null {
  const e = entidades(bruto).trim().toLowerCase().replace(/^mailto:/, '');
  if (!/^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(e)) return null;
  const [local, dominio] = e.split('@') as [string, string];
  if (EMAIL_ARQUIVO.test(e) || EMAIL_DOMINIO_LIXO.test(dominio) || EMAIL_LOCAL_LIXO.test(local)) return null;
  return e;
}

// Telefone brasileiro em dígitos, sem DDI. Rejeita o que a regex pesca por
// acidente: CPF/CNPJ solto, código de rastreio, 0800 de template.
export function normalizarFone(bruto: string): string | null {
  let d = bruto.replace(/\D/g, '');
  if (d.length === 12 || d.length === 13) {
    if (!d.startsWith('55')) return null; // número estrangeiro: não é para cá
    d = d.slice(2);
  }
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  const num = d.slice(2);
  if (num[0] === '0' || num[0] === '1') return null;       // nenhum assinante começa assim
  if (d.length === 11 && num[0] !== '9') return null;      // celular de 9 dígitos começa em 9
  if (/^(\d)\1+$/.test(num)) return null;                  // 4444-4444 de template
  return d;
}

interface Valor { tipo: 'email' | 'telefone' | 'whatsapp'; valor: string }

const RE_EMAIL_TEXTO = /[a-z0-9][a-z0-9._%+-]{0,62}@[a-z0-9][a-z0-9.-]{0,61}\.[a-z]{2,}/gi;
// (?<!\d) e (?!\d) são o que impede casar DENTRO de uma sequência maior: sem
// eles, um CPF de 11 dígitos ou um WhatsApp de 13 viravam "telefone" truncado.
const RE_FONE_TEXTO = /(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}(?!\d)/g;
const CTX_WHATS = /(whats|zap|wpp|celular|\bcel\b|m[óo]vel)/i;
const CTX_FONE = /(fone|tel|telefone|contato|whats|zap|wpp|celular|\bcel\b|ligue|central|atendimento|comercial)/i;
// Obfuscação comum no rodapé para escapar de robô de spam.
const desobfuscar = (s: string): string => s
  .replace(/\s*[([{]\s*(?:arroba|at)\s*[)\]}]\s*/gi, '@')
  .replace(/\s+(?:arroba)\s+/gi, '@')
  .replace(/\s*[([{]\s*(?:ponto|dot)\s*[)\]}]\s*/gi, '.');

// Valores de UMA linha + o texto que sobrou dela (candidato a rótulo/nome).
function extrair(linha: string): { valores: Valor[]; texto: string } {
  const valores: Valor[] = [];
  const add = (tipo: Valor['tipo'], valor: string | null): void => {
    if (valor && !valores.some((v) => v.tipo === tipo && v.valor === valor)) valores.push({ tipo, valor });
  };

  // 1. Marcadores: a própria empresa declarou "isto é contato". Confiança máxima.
  RE_TOKEN.lastIndex = 0;
  const semToken = linha.replace(RE_TOKEN, (_m, t: string, v: string) => {
    if (t === 'E') add('email', normalizarEmail(v));
    else add(t === 'W' ? 'whatsapp' : 'telefone', normalizarFone(v));
    return ' ';
  });

  // 2. E-mail em texto puro. Some da linha antes da varredura de telefone, senão
  //    os dígitos de 'contato2024@...' entram na conta como número.
  const semEmail = desobfuscar(semToken).replace(RE_EMAIL_TEXTO, (m) => {
    const e = normalizarEmail(m);
    if (e) { add('email', e); return ' '.repeat(m.length); }
    return m;
  });

  // 3. Telefone em texto puro, classificado pelo que vem imediatamente antes.
  const texto = semEmail.replace(RE_FONE_TEXTO, (m: string, pos: number) => {
    const antes = semEmail.slice(Math.max(0, pos - 30), pos);
    // Sequência crua, sem parêntese nem separador: é tão parecida com CPF, CNPJ
    // e código de pedido que só entra se houver rótulo de telefone por perto.
    if (/^\+?\d+$/.test(m) && !CTX_FONE.test(antes)) return m;
    const f = normalizarFone(m);
    if (!f) return m;
    add(CTX_WHATS.test(antes) ? 'whatsapp' : 'telefone', f);
    return ' '.repeat(m.length);
  });

  return { valores, texto };
}

// \b não serve aqui: em JS a letra acentuada não é caractere de palavra, então
// \b antes de "área" nunca casa. As fronteiras são (?<!\p{L}) / (?!\p{L}).
// Falta de fronteira já custou caro: sem ela "KaLINKa" casava com 'link' e o
// nome da pessoa era descartado.
const RE_SETOR = new RegExp(
  '(?<!\\p{L})(?:departamento|setor|comercial|comercializa|vendas?|compras?|financeir|cont[áa]bil|contabilidade|jur[íi]dic|marketing|comunica[çc][ãa]o|administrativ|recursos humanos|rh|sac|atendimento|suporte|t[ée]cnic|log[íi]stic|transportes?|exporta|importa|filial|filiais|unidade|matriz|loja|f[áa]brica|escrit[óo]rio|inform[áa]tica|ouvidoria|or[çc]ament|revenda|representante|gerente|diretor|respons[áa]vel|coordena|superviso)',
  'iu',
);
// Título de seção e chamada de menu que passariam por nome próprio ("Fale
// Conosco", "Links Úteis") se olhássemos só a caixa alta das iniciais.
const RE_NAO_NOME = new RegExp(
  '(?<!\\p{L})(?:fale|conosco|contato|home|in[íi]cio|sobre|nossa|nosso|saiba|clique|leia|veja|todos|direitos|reservados|pol[íi]tica|privacidade|whatsapp|telefone|e-?mail|endere[çc]o|hor[áa]rio|central|newsletter|cadastre|receba|siga|acesse|produ[çc][ãa]o|produtos?|servi[çc]os?|empresa|institucional|blog|not[íi]cias?|links?|[úu]teis|mapas?|portal|[áa]reas?|acesso|trabalhe|redes|sociais|termos|copyright|desenvolvido)(?!\\p{L})',
  'iu',
);
const MINUSCULAS_NOME = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
// Sigla de estado no fim: "Campos Novos SC" é praça, não pessoa. Sem isso a
// página de unidades enche a lista de "nomes" que são cidades.
const UF = /\s(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/;

// Nome do CAMPO, não do contato: "Fone:", "E-mail", "Whats". Aparece sozinho na
// linha em site que usa tabela, e não pode virar rótulo (a coocam ficou com 15
// contatos rotulados "Fones" em /unidades, perdendo o nome da filial) nem
// quebrar o bloco da pessoa a que o campo pertence.
const CAMPOS =
  'e-?mails?|telefones?|fones?|tels?|whats(?:app)?|zap|celulares?|contatos?|endere[çc]os?|cnpj|cep|hor[áa]rios?(?: de atendimento)?|fax|ramal|site';
const RE_CAMPO = new RegExp(`^(?:${CAMPOS})\\s*:?\\s*$`, 'i');
// Mesmos nomes, para limpar a sobra da linha: em "Fone: 3541-7000 · Whats: …"
// o que resta depois de tirar os números é só nome de campo, não é rótulo.
const RE_CAMPO_PALAVRA = new RegExp(`(?<!\\p{L})(?:${CAMPOS})(?!\\p{L})\\s*:?`, 'giu');

// "Silvio Zanon - Gerente" -> nome + cargo. O traço é a convenção universal
// nessas páginas; sem ele o cargo fica null e só o nome é aproveitado.
const partirNome = (l: string): [string, string | null] => {
  const [n, c] = l.split(/\s*[-–—|]\s*/, 2);
  return [n!.trim(), c?.trim() || null];
};

export function pareceNome(linha: string): boolean {
  const [s] = partirNome(linha);
  if (s.length < 5 || s.length > 60) return false;
  if (/[\d@:;/\\|()]/.test(s)) return false;
  if (RE_SETOR.test(s) || RE_NAO_NOME.test(s) || UF.test(s)) return false;
  const palavras = s.split(/\s+/);
  if (palavras.length < 2 || palavras.length > 5) return false;
  return palavras.every((p) => /^[A-ZÀ-Ý]/.test(p) || MINUSCULAS_NOME.has(p.toLowerCase()));
}

// Qualquer linha curta que não seja frase serve de rótulo: é assim que "Filial
// Curitibanos" e "Comercialização Insumos" são capturados sem uma lista fechada
// de setores, que nunca cobriria o vocabulário de todo site. Frase (termina em
// pontuação ou passa de 6 palavras) é texto institucional, não rótulo.
export function pareceRotulo(linha: string): boolean {
  if (linha.length > 60 || RE_CAMPO.test(linha)) return false;
  if (!/\p{L}/u.test(linha) || /[.!?]$/.test(linha)) return false;
  return linha.split(/\s+/).length <= 6;
}

interface Grupo { nome: string | null; cargo: string | null; rotulo: string | null; valores: Valor[] }

// Percorre as linhas mantendo o último nome e o último rótulo vistos, e fecha o
// grupo assim que aparece uma linha sem valor. É isso que mantém junto o bloco
//
//   Departamento Técnico          <- rótulo
//   Silvio Zanon - Gerente        <- nome + cargo
//   Email: silvio@coocam.com.br   <- valores do mesmo grupo
//   Whats: (49) 98832-1048
//   Fone: (49) 3541-7021
//
// e ao mesmo tempo separa os 21 e-mails da lista de setores da mesma página,
// onde cada rótulo é seguido de um único e-mail.
function agrupar(linhas: string[]): Grupo[] {
  const grupos: Grupo[] = [];
  let atual: Grupo | null = null;
  let nome: string | null = null;
  let cargo: string | null = null;
  let rotulo: string | null = null;
  const fechar = (): void => {
    if (atual && atual.valores.length) {
      grupos.push(atual);
      // A pessoa acabou de ser consumida: sem isso o nome vazaria para o próximo
      // bloco sem dono (foi como 'coocam@' virou contato da Kalinka na coocam).
      nome = null; cargo = null;
    }
    atual = null;
  };

  for (const linha of linhas) {
    const { valores, texto } = extrair(linha);
    if (valores.length) {
      // Rótulo grudado no valor, na mesma linha: "Comercialização Insumos <a>fabricio@…"
      // ou a linha de tabela "<td>Vendas</td><td>vendas@…</td>".
      const sobra = texto.replace(RE_CAMPO_PALAVRA, ' ').replace(/[\s:·|•\-–—]+/g, ' ').trim();
      const proprioDono = sobra !== '' && (pareceNome(sobra) || pareceRotulo(sobra));
      // A linha traz o dono dela: o que vinha antes acabou aqui. Sem isso uma
      // lista de setores (um por linha) viraria um contato só com 12 e-mails.
      if (proprioDono && atual?.valores.length) fechar();
      atual ??= { nome, cargo, rotulo, valores: [] };
      if (sobra && !atual.nome && pareceNome(sobra)) [atual.nome, atual.cargo] = partirNome(sobra);
      else if (sobra && !atual.rotulo && pareceRotulo(sobra)) atual.rotulo = sobra;
      atual.valores.push(...valores);
      continue;
    }
    // "Fone:" sozinho é o nome do campo seguinte: não fecha o bloco nem apaga
    // de quem ele é. Fechar aqui separaria a pessoa do telefone dela.
    if (RE_CAMPO.test(linha)) continue;
    fechar();
    if (pareceNome(linha)) {
      [nome, cargo] = partirNome(linha);
    } else if (pareceRotulo(linha)) {
      rotulo = linha.replace(/:$/, '').trim();
      nome = null; cargo = null;
    } else {
      // Frase ou texto corrido: o contexto anterior morreu junto.
      nome = null; cargo = null; rotulo = null;
    }
  }
  fechar();
  return grupos;
}

// Um grupo pode ter mais valores de um tipo que de outro (uma unidade com 3
// telefones e 1 e-mail). Zipa por índice: a 1ª linha leva o conjunto completo, as
// demais herdam só o rótulo — o nome fica na primeira para não duplicar pessoa.
function emGrupo(g: Grupo, origem: string): ContatoSite[] {
  const so = (t: Valor['tipo']): string[] => g.valores.filter((v) => v.tipo === t).map((v) => v.valor);
  const emails = so('email'); const tels = so('telefone'); const zaps = so('whatsapp');
  const n = Math.max(emails.length, tels.length, zaps.length);
  const out: ContatoSite[] = [];
  for (let i = 0; i < n; i++) {
    const email = emails[i] ?? null; const telefone = tels[i] ?? null; const whatsapp = zaps[i] ?? null;
    if (!email && !telefone && !whatsapp) continue;
    out.push({
      nome: i === 0 ? g.nome : null,
      cargo: i === 0 ? g.cargo : null,
      rotulo: g.rotulo, email, telefone, whatsapp, origem,
    });
  }
  return out;
}

// Prioridade para quem vende: representante quer o comprador, não o RH. Empata
// pela ordem em que apareceu no site (sort estável).
const PRIORIDADE: [RegExp, number][] = [
  [/(vendas?|comercial|comercializa|compras?|or[çc]ament|representante|revenda)/i, 0],
  [/(contato|atendimento|\bsac\b|central)/i, 1],
  [/(\brh\b|recursos humanos|curr[íi]culo|jur[íi]dico|financeiro|cont[áa]bil|contabilidade|fiscal|\bnfe\b|nota fiscal|inform[áa]tica|\bti\b|suporte|ouvidoria|imprensa|marketing|comunica)/i, 3],
];

function peso(c: ContatoSite): number {
  const alvo = `${c.rotulo ?? ''} ${c.cargo ?? ''} ${c.email ?? ''}`;
  for (const [re, p] of PRIORIDADE) if (re.test(alvo)) return p;
  return 2;
}

// O mesmo e-mail costuma aparecer duas vezes na página de contato: uma na lista
// de setores e outra na ficha da pessoa, com telefone junto. Mesclar em vez de
// duplicar é o que transforma duas linhas pobres numa linha completa.
//
// Fundir por telefone tem um limite: o número da central aparece na ficha de
// várias pessoas, e juntar por ele apagaria o e-mail de todas menos a primeira.
// Por isso e-mails diferentes nunca se fundem, mesmo compartilhando o telefone.
function mesclar(itens: ContatoSite[]): ContatoSite[] {
  const porEmail = new Map<string, ContatoSite>();
  const porFone = new Map<string, ContatoSite>();
  const saida: ContatoSite[] = [];

  for (const c of itens) {
    let alvo = c.email ? porEmail.get(c.email) : undefined;
    if (!alvo) {
      for (const f of [c.telefone, c.whatsapp]) {
        const cand = f ? porFone.get(f) : undefined;
        if (cand && !(cand.email && c.email && cand.email !== c.email)) { alvo = cand; break; }
      }
    }
    if (alvo) {
      alvo.nome ??= c.nome;
      alvo.cargo ??= c.cargo;
      alvo.rotulo ??= c.rotulo;
      alvo.email ??= c.email;
      alvo.telefone ??= c.telefone;
      alvo.whatsapp ??= c.whatsapp;
    } else {
      alvo = { ...c };
      saida.push(alvo);
    }
    if (alvo.email) porEmail.set(alvo.email, alvo);
    if (alvo.telefone) porFone.set(alvo.telefone, alvo);
    if (alvo.whatsapp) porFone.set(alvo.whatsapp, alvo);
  }
  return saida;
}

export function extrairContatos(html: string, origem: string): ContatoSite[] {
  return agrupar(linearizar(html)).flatMap((g) => emGrupo(g, origem));
}

// Páginas do PRÓPRIO site que valem visitar. Só o mesmo domínio (ignorando www):
// link para o Instagram ou para o site do fornecedor não entra na fila.
export function linksCandidatos(html: string, base: string): string[] {
  let origem: URL;
  try { origem = new URL(base); } catch { return []; }
  const vistos = new Set<string>();
  const achados: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"'>]+)["']/gi)) {
    let u: URL;
    try { u = new URL(entidades(m[1]!.trim()), origem); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (hostBase(u.hostname) !== hostBase(origem.hostname)) continue;
    if (ARQUIVO.test(u.pathname) || !RE_PAGINA_CONTATO.test(u.pathname)) continue;
    u.hash = '';
    const url = u.toString();
    if (vistos.has(url)) continue;
    vistos.add(url);
    achados.push(url);
  }
  // Página de contato antes de "sobre": rende muito mais e o orçamento é curto.
  const rank = (u: string): number => (/(contato|contact|fale|atendimento)/i.test(u) ? 0 : 1);
  return achados.sort((a, b) => rank(a) - rank(b));
}

// 401/403/429: o servidor está de pé e recusou o robô, não é ausência de site.
const BLOQUEIO = new Set([401, 403, 405, 406, 429]);
const legivel = (p: { html: string; status: number } | null): boolean =>
  p != null && p.status === 200 && p.html !== '';

export async function buscarContatosNoSite(siteUrl: string): Promise<BuscaContatos> {
  const inicio = Date.now();
  const home = await buscarPagina(siteUrl);
  if (home === null || !legivel(home)) {
    return { contatos: [], paginas: [], bloqueado: home !== null && BLOQUEIO.has(home.status) };
  }

  const paginas = [home];
  const fila: string[] = [];
  const enfileirar = (u: string): void => {
    if (u !== home.url && !fila.includes(u)) fila.push(u);
  };
  for (const l of linksCandidatos(home.html, home.url)) enfileirar(l);
  // Caminhos comuns entram DEPOIS dos links reais e servem para o site que não
  // linka contato no menu (menu em imagem, em JS ou dentro de frame).
  for (const c of CAMINHOS_COMUNS) {
    try { enfileirar(new URL(c, home.url).toString()); } catch { /* base estranha */ }
  }

  for (const alvo of fila) {
    if (paginas.length >= MAX_PAGINAS || Date.now() - inicio > PRAZO_MS) break;
    const p = await buscarPagina(alvo);
    // Redirect faz '/contato' e '/contatos' caírem na mesma URL final: ler duas
    // vezes só gastaria o orçamento de páginas.
    if (p && legivel(p) && !paginas.some((x) => x.url === p.url)) paginas.push(p);
  }

  const contatos = mesclar(paginas.flatMap((p) => extrairContatos(p.html, p.url)))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => peso(a.c) - peso(b.c) || a.i - b.i)
    .slice(0, MAX_CONTATOS)
    .map(({ c }) => c);

  return { contatos, paginas: paginas.map((p) => p.url), bloqueado: false };
}
