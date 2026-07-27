// Formatadores compartilhados (antes duplicados em Kanban/Finance/Routes/Catalog).

// moeda com centavos (financeiro, catálogo)
export const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// moeda sem centavos (KPIs/cards, onde centavo é ruído)
export const brl0 = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

// 'YYYY-MM-DD' -> data pt-BR (T00:00:00 evita shift de fuso)
export const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '';
  // data pura (YYYY-MM-DD): fixa meia-noite local p/ não recuar 1 dia por fuso.
  // timestamp completo (created_at etc): parseia direto — senão vira Invalid Date.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
};

export const todayStr = (): string => new Date().toISOString().slice(0, 10);

// Number de valor digitado aceitando vírgula OU ponto decimal (pt-BR). Para
// inputs type="text"/inputMode="decimal" onde o usuário pode digitar "1,5".
// '' / inválido -> NaN (caller trata com `|| 0` ou checagem própria).
export const dec = (s: string | number | null | undefined): number =>
  s == null || s === '' ? NaN : Number(String(s).replace(',', '.'));

// numeric cru do banco -> string limpa para input de edição. Tira zeros à
// direita SEM arredondar (preserva precisão): '90.000000'->'90',
// '10.330000'->'10.33', '10.333'->'10.333'. Mantém o valor cru editável; o
// arredondamento acontece só na borda (NF/exibição via brl).
export const numStr = (v: number | string | null | undefined): string =>
  v == null || v === '' ? '' : String(Number(v));

// número p/ célula de CSV no padrão pt-BR (vírgula decimal), sem símbolo —
// o Excel pt-BR lê como número. Ex.: 1234.5 -> "1234,50".
export const csvNum = (v: number | string): string => {
  const n = Number(v);
  return Number.isFinite(n)
    ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
    : '0,00';
};

/* ── Máscaras de entrada (aplicar no onChange) ──────────────────────────────
   Formatam enquanto o usuário digita; quando o backend espera número puro,
   guardar só os dígitos/parse no estado. Sem dependência — string slicing. */

// telefone BR: (11) 3333-4444 / (11) 93333-4444. Números vindos do WhatsApp
// chegam com DDI 55 (12–13 dígitos); nacional tem no máx. 11, então ≥12
// começando com 55 é DDI (não confunde com DDD 55) e cai fora antes da máscara.
export const maskPhone = (v: string): string => {
  let d = v.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  d = d.slice(0, 11);
  if (d.length <= 2) return d.replace(/^(\d{0,2})/, '($1');
  if (d.length <= 6) return d.replace(/^(\d{2})(\d{0,4})/, '($1) $2');
  if (d.length <= 10) return d.replace(/^(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
  return d.replace(/^(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
};

// CEP: 00000-000
export const maskCEP = (v: string): string => {
  const d = v.replace(/\D/g, '').slice(0, 8);
  return d.replace(/^(\d{5})(\d)/, '$1-$2');
};

// Placa BR: ABC1D23 (Mercosul) ou ABC1234 (antiga). Uppercase + só
// letras/dígitos, máx 7 chars. Não força layout (aceita ambos formatos);
// posição 5 pode ser letra (Mercosul) ou dígito (antiga).
export const maskPlaca = (v: string): string =>
  v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 7);

// CNPJ: 00.000.000/0000-00. Suporta o CNPJ alfanumérico (RFB, a partir de
// 2026): as 12 primeiras posições aceitam letra OU dígito (uppercase); os 2
// dígitos verificadores seguem sempre numéricos — letra digitada ali é
// descartada.
export const maskCNPJ = (v: string): string => {
  const raw = v.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  const d = (raw.slice(0, 12) + raw.slice(12).replace(/[^0-9]/g, '')).slice(0, 14);
  return d
    .replace(/^([0-9A-Z]{2})([0-9A-Z])/, '$1.$2')
    .replace(/^([0-9A-Z]{2})\.([0-9A-Z]{3})([0-9A-Z])/, '$1.$2.$3')
    .replace(/\.([0-9A-Z]{3})([0-9A-Z])/, '.$1/$2')
    .replace(/([0-9A-Z]{4})(\d)/, '$1-$2');
};

// Máscara p/ campos de busca que aceitam nome OU CNPJ. Só formata como CNPJ
// quando a entrada é numérica (sem letras) e já tem ≥4 dígitos em sequência;
// texto de nome passa intacto. O backend/filtros extraem só os dígitos, então
// a máscara é cosmética e não quebra a busca. Casado com a regra do servidor
// em /api/companies/search (CNPJ quando sem letras e ≥4 dígitos).
// Limitação conhecida: CNPJ alfanumérico digitado aqui cai na busca por nome
// (letra é indistinguível de nome) — quando a base RFB passar a ter CNPJs com
// letra, a heurística client+server precisa ser revista junta.
export const maskSearchCNPJ = (v: string): string =>
  /[a-zA-Z]/.test(v) || v.replace(/\D/g, '').length < 4 ? v : maskCNPJ(v);

// Percentual 0–100 p/ inputs type="text" inputMode="decimal": mantém só
// dígitos + 1 separador decimal (até 2 casas), normaliza p/ vírgula e capa
// em 100. Guarda string editável; o caller faz dec() no submit. '' fica ''.
export const maskPct = (v: string): string => {
  const [int, ...rest] = v.replace(/[^\d.,]/g, '').replace(/[.,]/g, ',').split(',');
  const out = rest.length ? `${int},${rest.join('').slice(0, 2)}` : int;
  return dec(out) > 100 ? '100' : out;
};

// Máscara de dinheiro p/ inputs type="text" inputMode="decimal": só dígitos + 1
// separador decimal (até 2 casas), normaliza p/ vírgula, bloqueia negativo (sem
// sinal) e capa a parte inteira em maxInt dígitos (default 12 → ~trilhão, evita
// valor absurdo). Guarda string editável; o caller faz dec() no submit. '' fica ''.
export const maskMoney = (v: string, maxInt = 12): string => {
  const [int, ...rest] = v.replace(/[^\d.,]/g, '').replace(/[.,]/g, ',').split(',');
  const intCut = (int ?? '').slice(0, maxInt);
  return rest.length ? `${intCut},${rest.join('').slice(0, 2)}` : intCut;
};

// Máscara de dinheiro COM separador de milhar (1.234.567,89) — para campos onde
// a ordem de grandeza é o que importa (ex.: faixa de capital social, onde
// "1000000" e "10000000" são indistinguíveis a olho). Difere de maskMoney, que
// guarda o valor sem agrupamento. Parear sempre com decBR() na leitura: dec()
// não entende o ponto de milhar. '' fica ''.
export const maskMoneyBR = (v: string, maxInt = 12): string => {
  // ponto digitado é milhar (cai fora); vírgula é o decimal. Só a 1ª vírgula vale.
  const [int, ...rest] = v.replace(/[^\d.,]/g, '').replace(/\./g, '').split(',');
  const intCut = (int ?? '').slice(0, maxInt);
  const grouped = intCut.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return rest.length ? `${grouped},${rest.join('').slice(0, 2)}` : grouped;
};

// Number de string em pt-BR COM milhar: '1.234.567,89' -> 1234567.89. Contraparte
// de maskMoneyBR (dec() sozinho lê o ponto de milhar como decimal e dá NaN).
export const decBR = (s: string | null | undefined): number =>
  s == null || s.trim() === '' ? NaN : Number(s.replace(/\./g, '').replace(',', '.'));

// Capa um número em [min, max]. NaN/inválido → min. Para sanitizar inputs
// numéricos que salvam fora de <form> (min/max nativos não disparam sem submit).
export const clampNum = (v: number | string | null | undefined, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : dec(v ?? '');
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};

/* ── Validadores ────────────────────────────────────────────────────────────
   Aplicar no submit (não no onChange — máscara formata, validador bloqueia). */

// e-mail: mesma regex antes duplicada em Contatos/Kanban/WhatsApp/EmailAgendado/
// activityModal/Carriers. Pragmática (algo@algo.tld), não RFC completa — mais
// estrita que o type="email" nativo (que aceita "a@b" sem TLD).
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const isEmail = (v: string): boolean => EMAIL_RE.test(v.trim());

// CNPJ: dígitos verificadores (módulo 11). Complementa maskCNPJ — a máscara
// formata, isto valida. Suporta CNPJ alfanumérico: cada caractere vale
// charCode − 48 ('0'–'9' → 0–9, 'A'–'Z' → 17–42, regra da RFB); DVs sempre
// numéricos. Rejeita sequência repetida (00.000.000/0000-00 etc).
export const validCNPJ = (v: string): boolean => {
  const d = v.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{12}\d{2}$/.test(d) || /^(.)\1{13}$/.test(d)) return false;
  const val = (i: number): number => d.charCodeAt(i) - 48;
  const dv = (len: number): number => {
    let sum = 0, w = len - 7;
    for (let i = 0; i < len; i++) { sum += val(i) * w; w = w === 2 ? 9 : w - 1; }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === val(12) && dv(13) === val(13);
};

// CPF: 000.000.000-00. Hoje não há campo de CPF no app (base de empresas é
// PJ; CPF de sócios chega mascarado da Receita) — utilitário pronto p/ quando
// surgir. Par com validCPF abaixo.
export const maskCPF = (v: string): string => {
  const d = v.replace(/\D/g, '').slice(0, 11);
  return d
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
};

// CPF: dígitos verificadores (módulo 11). Rejeita sequência repetida.
export const validCPF = (v: string): boolean => {
  const d = v.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
};

// Guarda de submit: true só quando o CNPJ está completo (14 caracteres,
// contando letras do alfanumérico) com DV errado. Parcial/legado passa —
// registros antigos guardam CNPJ incompleto e não podem travar a edição dos
// demais campos do formulário.
export const invalidCNPJ = (v: string): boolean => {
  const d = v.replace(/[^0-9a-zA-Z]/g, '');
  return d.length === 14 && !validCNPJ(d);
};

// UF: só letras, uppercase, 2 chars. Máscara p/ onChange (não valida sigla —
// backend/uso é livre; evita lista hardcoded p/ campo raramente digitado).
export const maskUF = (v: string): string =>
  v.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2);

// link wa.me (WhatsApp click-to-chat). Assume DDI Brasil (55) quando ausente.
// Retorna null se não houver dígitos suficientes p/ um telefone válido.
export const waLink = (tel: string | null | undefined): string | null => {
  if (!tel) return null;
  const d = tel.replace(/\D/g, '');
  if (d.length < 10) return null;
  return `https://wa.me/${d.length <= 11 ? `55${d}` : d}`;
};
