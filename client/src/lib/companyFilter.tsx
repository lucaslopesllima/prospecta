import { useEffect, useMemo, useRef, useState } from 'react';
import { api, BUSCA_DEBOUNCE_MS } from './api.ts';
import type { Municipio } from './types.ts';
import { maskSearchCNPJ, maskCEP, maskMoneyBR, dec, decBR } from './format.ts';
import { Btn, cn, Hint, inputCls, SafeButton } from './ui.tsx';
import { Icon } from './icons.tsx';
import { Cnae, seedCnae } from './cnae.tsx';

// Filtro de empresas reutilizado no Funil e na Prospecção (Recomendadas).
// No modo recommend, a barra também guarda a configuração da recomendação
// (território, partida e pesos do score) — que antes vinha do perfil-alvo e agora
// vive aqui, persistida no navegador e enviada ao /api/recommend a cada busca.

const onlyDigits = (s: string): string => s.replace(/\D/g, '');
const parseCodes = (s: string): number[] => s.split(/[,\s]+/).map((x) => onlyDigits(x)).filter(Boolean).map(Number);
// anos inteiros (tempo de vida): só dígitos, máx. 3 casas (999 anos)
const maskAnos = (v: string): string => onlyDigits(v).slice(0, 3);
const PORTE_OPTS = [
  { v: 'micro', l: 'Micro' }, { v: 'pequeno', l: 'Pequeno' },
  { v: 'demais', l: 'Demais' }, { v: 'nao_informado', l: 'Não informado' },
];

export interface Pesos { cnae: number; proximidade: number; porte: number; capital: number; idade: number }
export const DEFAULT_PESOS: Pesos = { cnae: 0.4, proximidade: 0.25, porte: 0.15, capital: 0.1, idade: 0.1 };
export const PESO_LABEL: Record<keyof Pesos, string> = {
  cnae: 'CNAE',
  proximidade: 'Proximidade',
  porte: 'Porte',
  capital: 'Capital social',
  idade: 'Tempo de vida',
};
// Explica o que cada fator mede e como o peso age (tooltip ao lado do slider).
export const PESO_HINT: Record<keyof Pesos, string> = {
  cnae: 'Quanto a atividade da empresa se parece com os CNAEs-alvo: mesma classe vale 1,0; mesma divisão 0,6; mesma seção 0,3; nada em comum 0.',
  proximidade: 'Distância do município da empresa até o endereço de partida (ou o centro do território). Colada na origem vale 1,0 e cai até 0 em 150 km.',
  porte: 'Porte declarado na Receita Federal: demais (grande/média) 1,0 · pequeno 0,7 · micro 0,4 · não informado 0,2.',
  capital: 'Capital social registrado, em escala logarítmica: R$ 1 milhão ou mais vale 1,0 e valores baixos caem suavemente. Mede porte financeiro, não faturamento.',
  idade: 'Tempo desde a abertura da empresa: 20 anos ou mais vale 1,0, proporcional abaixo disso. Sem data na base, o fator fica 0 (não pesa contra).',
};
const PESO_SLIDER_HINT = 'O peso multiplica o fator: 0 desliga, 1 faz ele pesar o máximo. O score final é a soma dos cinco fatores.';

// Faixas (filtro duro) de capital social e tempo de vida. Strings porque os
// campos guardam o valor editável mascarado; '' = sem limite naquela ponta.
export interface Faixas { capMin: string; capMax: string; idadeMin: string; idadeMax: string }
export const FAIXAS_VAZIAS: Faixas = { capMin: '', capMax: '', idadeMin: '', idadeMax: '' };

// Reaplica a máscara no que veio do localStorage: valores salvos antes da máscara
// de milhar ('1000000') passam a exibir '1.000.000' já na abertura da tela.
function normFaixas(f: Partial<Faixas> | undefined): Faixas {
  const v = { ...FAIXAS_VAZIAS, ...f };
  return { ...v, capMin: maskMoneyBR(v.capMin), capMax: maskMoneyBR(v.capMax) };
}

// Faixa inválida = mínimo maior que o máximo (com as duas pontas preenchidas).
// Bloqueia a busca: mandar cap_min > cap_max ao servidor só devolve lista vazia.
export function faixaCapitalInvalida(f: Faixas): boolean {
  return f.capMin.trim() !== '' && f.capMax.trim() !== '' && decBR(f.capMin) > decBR(f.capMax);
}
export function faixaIdadeInvalida(f: Faixas): boolean {
  return f.idadeMin.trim() !== '' && f.idadeMax.trim() !== '' && dec(f.idadeMin) > dec(f.idadeMax);
}
export const faixasInvalidas = (f: Faixas): boolean => faixaCapitalInvalida(f) || faixaIdadeInvalida(f);

// Endereço de partida das rotas: origem que o usuário define à mão nos filtros,
// geocodificada para lat/lon. Sobrescreve o endereço da conta nos cálculos de
// distância/rota. Compartilhada entre telas (Prospecção + Planejador).
export interface Partida { label: string; lat: number; lon: number }

// Config da recomendação compartilhada entre telas (busca + mapa de cobertura).
// Guardada fora do filtro por-tela porque o território é um conceito global.
interface RecoCfg { munis: Municipio[]; pesos: Pesos; partida: Partida | null }
const RECO_KEY = 'companyFilter:reco';

function loadRecoCfg(): RecoCfg {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(RECO_KEY) : null;
    if (raw) {
      const p = JSON.parse(raw) as Partial<RecoCfg>;
      return { munis: p.munis ?? [], pesos: { ...DEFAULT_PESOS, ...p.pesos }, partida: p.partida ?? null };
    }
  } catch { /* storage indisponível */ }
  return { munis: [], pesos: { ...DEFAULT_PESOS }, partida: null };
}

// Lido por outras telas (ex.: mapa de cobertura) que precisam do mesmo território.
export function loadTerritorioIds(): number[] {
  return loadRecoCfg().munis.map((m) => m.id);
}

// Lido pelo Planejador de rota para usar a mesma origem definida nos filtros.
export function loadPartida(): Partida | null {
  return loadRecoCfg().partida;
}

// Mínimo que um item precisa expor para ser filtrável.
export interface FilterableCompany {
  razao_social: string; nome_fantasia: string | null; cnpj: string;
  cnae_principal: number; uf: string; municipio_id: number | null; porte: string;
}

export interface CompanyFilter {
  fq: string; setFq: (s: string) => void;
  fCnae: string; setFCnae: (s: string) => void;
  fPorte: string; setFPorte: (s: string) => void;
  // config da recomendação (modo recommend)
  territorio: Municipio[]; setTerritorio: (m: Municipio[]) => void;
  pesos: Pesos; setPesos: (p: Pesos) => void;
  partida: Partida | null; setPartida: (p: Partida | null) => void;
  faixas: Faixas; setFaixas: (f: Faixas) => void;
  filtroAtivo: boolean;
  limpar: () => void;
  apply: <T extends FilterableCompany>(items: T[]) => T[];
}

interface Persisted { fq: string; fCnae: string; fPorte: string; faixas?: Faixas }

function loadSaved(key: string): Persisted | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch { return null; }
}

// storageKey separa a persistência por tela (funil vs prospecção).
export function useCompanyFilter(storageKey = 'default'): CompanyFilter {
  const key = `companyFilter:${storageKey}`;
  const saved = useMemo(() => loadSaved(key), [key]);
  const reco = useMemo(() => loadRecoCfg(), []);

  const [fq, setFq] = useState(saved?.fq ?? '');
  const [fCnae, setFCnae] = useState(saved?.fCnae ?? '');
  const [fPorte, setFPorte] = useState(saved?.fPorte ?? '');
  const [territorio, setTerritorio] = useState<Municipio[]>(reco.munis);
  const [pesos, setPesos] = useState<Pesos>(reco.pesos);
  const [partida, setPartida] = useState<Partida | null>(reco.partida);
  const [faixas, setFaixas] = useState<Faixas>(() => normFaixas(saved?.faixas));

  // Persiste o estado do filtro a cada mudança.
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ fq, fCnae, fPorte, faixas }));
    } catch { /* storage indisponível */ }
  }, [key, fq, fCnae, fPorte, faixas]);

  // Persiste a config da recomendação (compartilhada).
  useEffect(() => {
    try {
      localStorage.setItem(RECO_KEY, JSON.stringify({ munis: territorio, pesos, partida }));
    } catch { /* storage indisponível */ }
  }, [territorio, pesos, partida]);

  const apply = useMemo(() => {
    const cnaes = parseCodes(fCnae);
    const qd = onlyDigits(fq);
    const ql = fq.trim().toLowerCase();
    return <T extends FilterableCompany>(items: T[]): T[] => items.filter((c) => {
      if (ql) {
        const hay = `${c.razao_social} ${c.nome_fantasia ?? ''}`.toLowerCase();
        if (!(hay.includes(ql) || (qd !== '' && c.cnpj.includes(qd)))) return false;
      }
      if (cnaes.length && !cnaes.includes(c.cnae_principal)) return false;
      if (fPorte && c.porte !== fPorte) return false;
      return true;
    });
  }, [fq, fCnae, fPorte]);

  const faixaAtiva = Object.values(faixas).some((v) => v.trim() !== '');
  const filtroAtivo = fq.trim() !== '' || fCnae.trim() !== '' || fPorte !== '' || faixaAtiva;
  const limpar = (): void => {
    setFq(''); setFCnae(''); setFPorte('');
    setFaixas({ ...FAIXAS_VAZIAS });
  };

  return {
    fq, setFq, fCnae, setFCnae, fPorte, setFPorte,
    territorio, setTerritorio, pesos, setPesos, partida, setPartida, faixas, setFaixas,
    filtroAtivo, limpar, apply,
  };
}

// Fecha o dropdown ao clicar fora (mesmo padrão do CompanySearch). Vai no
// mousedown do documento e não no blur do input: o blur dispara ANTES do click
// no item da lista e engoliria a seleção.
function useCloseOnOutside(ref: React.RefObject<HTMLElement | null>, setOpen: React.Dispatch<React.SetStateAction<boolean>>): void {
  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [ref, setOpen]);
}

// Busca de CNAE por TEXTO ou código: digita "padaria" ou "478" e resolve via
// /api/cnae/search (sinônimos + descrição + trigrama). Guarda só os códigos em
// fCnae — formato que o filtro client-side e o /api/recommend já consomem.
interface CnaeHit { codigo: number; descricao: string; secao: string; divisao: number }
interface CnaeGrupo { divisao: number; secao: string; itens: CnaeHit[] }

function CnaeSearchInput({ value, onChange, label }: { value: string; onChange: (s: string) => void; label: string }): React.JSX.Element {
  const [q, setQ] = useState('');
  const [grupos, setGrupos] = useState<CnaeGrupo[]>([]);
  const [open, setOpen] = useState(false);
  const deb = useRef<number | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  useCloseOnOutside(boxRef, setOpen);

  const codes = useMemo(() => parseCodes(value), [value]);

  useEffect(() => {
    if (deb.current) clearTimeout(deb.current);
    const term = q.trim();
    if (term.length < 2) { setGrupos([]); return; }
    deb.current = window.setTimeout(async () => {
      const r = await api.get<{ grupos: CnaeGrupo[] }>(`/api/cnae/search?q=${encodeURIComponent(term)}`).catch(() => null);
      setGrupos(r?.grupos ?? []);
      setOpen(true);
    }, BUSCA_DEBOUNCE_MS);
  }, [q]);

  const add = (code: number, descricao?: string): void => {
    if (!Number.isFinite(code) || codes.includes(code)) { setQ(''); setGrupos([]); return; }
    if (descricao) seedCnae(code, descricao);
    onChange([...codes, code].join(', '));
    setQ(''); setGrupos([]); setOpen(false);
  };
  const remove = (code: number): void => onChange(codes.filter((c) => c !== code).join(', '));

  // Enter com dígitos puros adiciona o código direto, sem depender da busca.
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const digits = onlyDigits(q);
    if (digits) add(Number(digits));
  };

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-500">{label}</span>
      <div ref={boxRef} className="relative">
        <input
          value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          onFocus={() => { if (grupos.length) setOpen(true); }}
          maxLength={120} placeholder="Atividade (ex.: padaria) ou código" className={inputCls}
        />
        {open && grupos.length > 0 && (
          <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-ink-200 bg-surface py-1 shadow-pop">
            {grupos.map((g) => (
              <div key={g.divisao}>
                <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Divisão {g.divisao} · seção {g.secao}</div>
                {g.itens.map((it) => (
                  <button key={it.codigo} type="button" onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(it.codigo, it.descricao)} disabled={codes.includes(it.codigo)}
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-ink-50 disabled:opacity-40">
                    <span className="shrink-0 font-mono text-xs text-ink-400">{it.codigo}</span>
                    <span className="text-ink-700">{it.descricao}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {open && q.trim().length >= 2 && grupos.length === 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-400 shadow-pop">
            Nenhum CNAE encontrado para “{q.trim()}”.
          </div>
        )}
      </div>
      {codes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {codes.map((c) => (
            <button key={c} type="button" onClick={() => remove(c)}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-100">
              <span className="font-mono">{c}</span> <Cnae code={c} /> <Icon name="x" size={11} />
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

// Endereço de partida das rotas: usuário digita um endereço livre, geocodifica
// via /api/geocode e guarda lat/lon. Vira a origem dos cálculos de distância/rota
// (sobrescreve o endereço da conta). Vazio = usa o endereço cadastrado da conta.
function PartidaInput({ value, onChange }: { value: Partida | null; onChange: (p: Partida | null) => void }): React.JSX.Element {
  const [cep, setCep] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [cepBusy, setCepBusy] = useState(false);
  const [erro, setErro] = useState('');

  // CEP -> endereço (ViaCEP). Preenche o campo de endereço; o usuário ajusta o
  // número se quiser e confirma em "Definir" (geocodificação Nominatim).
  const buscarCep = async (raw: string): Promise<void> => {
    const digits = onlyDigits(raw);
    if (digits.length !== 8) return;
    setCepBusy(true); setErro('');
    try {
      const resp = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      const j = await resp.json() as { logradouro?: string; bairro?: string; localidade?: string; uf?: string; erro?: boolean };
      if (j.erro) { setErro('CEP não encontrado.'); return; }
      const addr = [j.logradouro, j.bairro, [j.localidade, j.uf].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      setQ(addr);
    } catch {
      setErro('Falha ao buscar o CEP.');
    } finally { setCepBusy(false); }
  };

  const buscar = async (): Promise<void> => {
    const term = q.trim();
    if (term.length < 3) { setErro('Digite um endereço (mín. 3 caracteres).'); return; }
    setBusy(true); setErro('');
    try {
      const r = await api.get<{ geocode: { lat: number; lon: number; label: string } | null }>(
        `/api/geocode?q=${encodeURIComponent(term)}`);
      if (!r.geocode) { setErro('Endereço não encontrado.'); return; }
      onChange({ label: r.geocode.label, lat: r.geocode.lat, lon: r.geocode.lon });
      setCep(''); setQ('');
    } catch {
      setErro('Falha ao localizar o endereço.');
    } finally { setBusy(false); }
  };

  return (
    <div className="block">
      <span className="text-xs font-semibold text-ink-600">Endereço de partida</span>
      {value ? (
        <div className="mt-1.5 flex items-start gap-2 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2">
          <Icon name="mapPin" size={15} className="mt-0.5 shrink-0 text-brand-600" />
          <span className="min-w-0 flex-1 text-xs text-brand-900">{value.label}</span>
          <button type="button" onClick={() => onChange(null)} title="Remover endereço de partida"
            className="shrink-0 text-brand-700 hover:text-rose-600"><Icon name="x" size={14} /></button>
        </div>
      ) : (
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <input value={cep} inputMode="numeric"
            onChange={(e) => { const v = maskCEP(e.target.value); setCep(v); setErro(''); if (onlyDigits(v).length === 8) void buscarCep(v); }}
            onBlur={(e) => void buscarCep(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void buscarCep(cep); } }}
            placeholder={cepBusy ? 'Buscando…' : 'CEP'} className={cn(inputCls, 'sm:w-32 shrink-0')} />
          <input value={q} onChange={(e) => { setQ(e.target.value); setErro(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void buscar(); } }}
            maxLength={120} placeholder="Ex.: Rua XV de Novembro 100, Blumenau SC" className={cn(inputCls, 'flex-1')} />
          <Btn size="sm" type="button" variant="soft" onClick={() => buscar()} disabled={busy} className="shrink-0">
            {busy ? '…' : 'Definir'}
          </Btn>
        </div>
      )}
      {erro && <p className="mt-1 text-[11px] text-rose-600">{erro}</p>}
    </div>
  );
}

// onBuscar: aplica os filtros na hora (sem esperar o debounce). A busca continua
// reativa — o botão é o caminho explícito de quem terminou de mexer nos campos;
// `buscando` desabilita enquanto a consulta roda.
// extra: campos próprios da tela (ex.: etapa/cenário/ação/private label no funil)
// entram no MESMO grid — uma barra só, sem um segundo cartão de filtros.
// onLimpar: substitui o `f.limpar` quando a tela tem filtros próprios para zerar
// junto — o botão é sempre um só, "Limpar filtros".
export function CompanyFilterBar({ f, recommend = false, onBuscar, buscando = false, extra, onLimpar }: {
  f: CompanyFilter; recommend?: boolean; onBuscar?: () => void; buscando?: boolean;
  extra?: React.ReactNode; onLimpar?: () => void;
}): React.JSX.Element {
  // Sem acordeão nenhum: o botão "Filtros" da página já abre/fecha a barra
  // inteira, então esconder metade dos campos atrás de um segundo toggle só
  // adicionava cliques. No recommend, território/pesos ficam no topo e os campos
  // básicos logo abaixo — tudo visível de uma vez. No funil só vão os campos:
  // endereço de partida é da prospecção/planejador de rota, não filtra nada lá.
  // No celular a barra vive DENTRO da folha do FilterPanel, que já dá moldura,
  // padding e rodapé — então aqui o cartão e a linha de ações somem para não
  // desenhar quadro dentro de quadro nem repetir Limpar/Buscar.
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-3 shadow-card max-sm:rounded-none max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:shadow-none">
      {recommend && <RecommendConfig f={f} />}

      <div className={cn('grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3',
        recommend && 'mt-3 border-t border-ink-100 pt-3')}>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-500">Nome / CNPJ</span>
          <input value={f.fq} onChange={(e) => f.setFq(maskSearchCNPJ(e.target.value))} maxLength={120} placeholder="Razão, fantasia ou CNPJ" className={inputCls} />
        </label>
        <CnaeSearchInput value={f.fCnae} onChange={f.setFCnae} label={recommend ? 'CNAEs-alvo' : 'CNAE'} />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-ink-500">Porte</span>
          <select value={f.fPorte} onChange={(e) => f.setFPorte(e.target.value)} className={inputCls}>
            <option value="">Todos</option>
            {PORTE_OPTS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
          </select>
        </label>
        {/* Faixas (só no recommend): corte duro no servidor, antes do ranqueamento.
            No funil não entram — o filtro do funil é client-side e a lista
            carregada não traz capital social nem data de abertura. */}
        {recommend && (
          <>
            <FaixaField label="Capital social" unidade="R$" hint={FAIXA_HINT.capital} mask={maskMoneyBR}
              prefixo="R$" invalido={faixaCapitalInvalida(f.faixas)}
              min={f.faixas.capMin} max={f.faixas.capMax}
              onMin={(v) => f.setFaixas({ ...f.faixas, capMin: v })}
              onMax={(v) => f.setFaixas({ ...f.faixas, capMax: v })} />
            <FaixaField label="Tempo de vida" unidade="anos" hint={FAIXA_HINT.idade} mask={maskAnos}
              invalido={faixaIdadeInvalida(f.faixas)}
              min={f.faixas.idadeMin} max={f.faixas.idadeMax}
              onMin={(v) => f.setFaixas({ ...f.faixas, idadeMin: v })}
              onMax={(v) => f.setFaixas({ ...f.faixas, idadeMax: v })} />
          </>
        )}
        {extra}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 border-t border-ink-100 pt-3 max-sm:hidden">
        <Btn variant="ghost" type="button" onClick={onLimpar ?? f.limpar}>Limpar filtros</Btn>
        {onBuscar && (
          <Btn type="button" icon="search" onClick={onBuscar} disabled={buscando}>
            {buscando ? 'Buscando…' : 'Buscar'}
          </Btn>
        )}
      </div>
    </div>
  );
}

// Faixas de capital social e tempo de vida: filtro duro (corta a base antes do
// ranqueamento), diferente dos pesos — que só reordenam o que passou. Ponta
// vazia = sem limite. Vai para o /api/recommend como cap_min/cap_max e
// idade_min/idade_max.
const FAIXA_HINT = {
  capital: 'Capital social declarado na Receita Federal (o valor que os sócios registraram na abertura ou na última alteração). Empresas fora da faixa somem do resultado.',
  idade: 'Anos desde a abertura da empresa (data de início de atividade). Empresas sem essa data na base saem do resultado quando você usa a faixa.',
} as const;

export function faixasParams(f: Faixas): Record<string, string> {
  const out: Record<string, string> = {};
  // capital vem mascarado com milhar -> decBR; anos são dígitos puros -> dec.
  if (f.capMin.trim()) out.cap_min = String(decBR(f.capMin));
  if (f.capMax.trim()) out.cap_max = String(decBR(f.capMax));
  if (f.idadeMin.trim()) out.idade_min = String(dec(f.idadeMin));
  if (f.idadeMax.trim()) out.idade_max = String(dec(f.idadeMax));
  return out;
}

// Um par mín/máx no grid do filtro simples (mesma célula que Nome/CNAE/Porte).
// `prefixo` desenha o R$ dentro do campo (dinheiro nunca é type="number").
function FaixaField({ label, unidade, hint, mask, prefixo, invalido, min, max, onMin, onMax }: {
  label: string; unidade: string; hint: string; mask: (v: string) => string;
  prefixo?: string; invalido: boolean;
  min: string; max: string; onMin: (v: string) => void; onMax: (v: string) => void;
}): React.JSX.Element {
  const campoCls = cn(inputCls, prefixo && 'pl-9', invalido && 'border-rose-300 focus:border-rose-400 focus:ring-rose-200');
  const campo = (v: string, ph: string, aria: string, onChange: (s: string) => void): React.JSX.Element => (
    <div className="relative flex-1">
      {prefixo && <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-400">{prefixo}</span>}
      <input value={v} inputMode="decimal" placeholder={ph} maxLength={20}
        onChange={(e) => onChange(mask(e.target.value))}
        aria-label={aria} aria-invalid={invalido} className={campoCls} />
    </div>
  );
  return (
    <div className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-500">
        {label} <span className="text-ink-300">({unidade})</span> <Hint text={hint} />
      </span>
      <div className="flex items-center gap-2">
        {campo(min, 'mín.', `${label} mínimo`, onMin)}
        <span className="shrink-0 text-xs text-ink-400">até</span>
        {campo(max, 'máx.', `${label} máximo`, onMax)}
      </div>
      {invalido && <p className="mt-1 text-[11px] text-rose-600">O valor inicial não pode ser maior que o limite — a busca fica parada até ajustar.</p>}
    </div>
  );
}

// Painel de configuração do score (modo recommend): território (municípios + UF
// inteiro), endereço de partida e pesos. Migrado da antiga tela de Perfil-alvo.
function RecommendConfig({ f }: { f: CompanyFilter }): React.JSX.Element {
  const [munQ, setMunQ] = useState('');
  const [munResults, setMunResults] = useState<Municipio[]>([]);
  const [ufs, setUfs] = useState<{ uf: string; total: number }[]>([]);
  const [munOpen, setMunOpen] = useState(false);
  const munDebounce = useRef<number | undefined>(undefined);
  const munBoxRef = useRef<HTMLDivElement>(null);
  useCloseOnOutside(munBoxRef, setMunOpen);

  useEffect(() => {
    void api.get<{ ufs: { uf: string; total: number }[] }>('/api/municipios/ufs')
      .then((r) => setUfs(r?.ufs ?? [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (munDebounce.current) clearTimeout(munDebounce.current);
    if (munQ.trim().length < 1) { setMunResults([]); return; }
    // aborta a busca anterior: sem isso, uma resposta em voo resolve DEPOIS do
    // addMun (que limpa munQ/munResults) e reabre o dropdown com resultado velho.
    const ctrl = new AbortController();
    munDebounce.current = window.setTimeout(async () => {
      try {
        const r = await api.get<{ municipios: Municipio[] }>(`/api/municipios/search?q=${encodeURIComponent(munQ.trim())}`, { signal: ctrl.signal });
        setMunResults(r?.municipios ?? []);
      } catch { /* abortada ou falhou: ignora */ }
    }, BUSCA_DEBOUNCE_MS);
    return () => ctrl.abort();
  }, [munQ]);

  const sel = f.territorio;
  const addMun = (m: Municipio): void => {
    if (!sel.some((x) => x.id === m.id)) f.setTerritorio([...sel, m]);
    setMunQ(''); setMunResults([]); setMunOpen(false);
  };
  const removeMun = (id: number): void => f.setTerritorio(sel.filter((x) => x.id !== id));
  const removeUf = (uf: string): void => f.setTerritorio(sel.filter((x) => x.uf !== uf));
  const toggleUf = async (uf: string, full: boolean): Promise<void> => {
    if (full) { removeUf(uf); return; }
    const novos = (await api.get<{ municipios: Municipio[] }>(`/api/municipios/by-uf?uf=${uf}`))?.municipios ?? [];
    const ids = new Set(sel.map((m) => m.id));
    f.setTerritorio([...sel, ...novos.filter((m) => !ids.has(m.id))]);
  };

  const countByUf: Record<string, number> = {};
  for (const m of sel) countByUf[m.uf] = (countByUf[m.uf] ?? 0) + 1;
  const isFull = (uf: string, total: number): boolean => (countByUf[uf] ?? 0) === total && total > 0;
  const fullUfs = ufs.filter((u) => isFull(u.uf, u.total)).map((u) => u.uf);
  const looseCities = sel.filter((m) => !fullUfs.includes(m.uf)).sort((a, b) => a.nome.localeCompare(b.nome));

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {/* Território */}
      <div className="rounded-2xl border border-hairline bg-surface p-3 shadow-card">
        {/* Único critério obrigatório da tela: sem município a busca nem sai
            (ver `semTerritorio` no Recommend). Marca o `*` da app, e o asterisco
            fica fora do texto lido em voz alta — o aria-label já diz. */}
        <h4 className="text-sm font-semibold text-ink-900">
          Território <span aria-hidden className="text-rose-500">*</span>
          <span className="sr-only">(obrigatório)</span>
        </h4>
        <p className="mb-1.5 mt-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Por estado</p>
        <div className="flex flex-wrap gap-1">
          {ufs.map((u) => {
            const full = isFull(u.uf, u.total);
            const partial = !full && (countByUf[u.uf] ?? 0) > 0;
            return (
              <SafeButton key={u.uf} onClick={() => toggleUf(u.uf, full)} title={`${u.total} municípios`}
                className={cn('rounded-lg px-2 py-1 text-xs font-bold transition-colors',
                  full ? 'bg-brand-600 text-white hover:bg-brand-700'
                    : partial ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200'
                    : 'bg-ink-100 text-ink-500 hover:bg-ink-200')}>
                {u.uf}{partial && <span className="ml-1 font-medium opacity-70">{countByUf[u.uf]}</span>}
              </SafeButton>
            );
          })}
        </div>

        <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Por cidade</p>
        <div ref={munBoxRef} className="relative">
          <Icon name="search" size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input value={munQ} onChange={(e) => { setMunQ(e.target.value); setMunOpen(true); }}
            onFocus={() => { if (munQ.trim()) setMunOpen(true); }}
            onKeyDown={(e) => { if (e.key === 'Escape') setMunOpen(false); }}
            maxLength={120} placeholder="Buscar cidade (ex.: Blumenau)…" className={cn(inputCls, 'pl-9')} />
          {munOpen && munResults.length > 0 && (
            <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-ink-200 bg-surface py-1 shadow-pop">
              {munResults.map((m) => {
                const on = sel.some((x) => x.id === m.id);
                return (
                  <button key={m.id} onClick={() => addMun(m)} disabled={on}
                    className={cn('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-ink-50 disabled:opacity-40', on && 'cursor-default')}>
                    <span className="truncate text-ink-700"><Icon name="mapPin" size={13} className="mr-1.5 inline text-ink-400" />{m.nome}</span>
                    <span className="shrink-0 text-xs font-semibold text-ink-400">{on ? 'adicionado' : m.uf}</span>
                  </button>
                );
              })}
            </div>
          )}
          {munOpen && munQ.trim().length >= 1 && munResults.length === 0 && (
            <div className="absolute z-20 mt-1 w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-sm text-ink-400 shadow-pop">
              Nenhuma cidade encontrada para “{munQ.trim()}”.
            </div>
          )}
        </div>

        {sel.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {fullUfs.map((uf) => (
              <button key={uf} onClick={() => removeUf(uf)}
                className="inline-flex items-center gap-1 rounded-full bg-brand-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-800">
                <Icon name="layers" size={12} /> {uf} inteiro · {countByUf[uf]} <Icon name="x" size={12} />
              </button>
            ))}
            {looseCities.map((m) => (
              <button key={m.id} onClick={() => removeMun(m.id)}
                className="inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-brand-700">
                {m.nome} <span className="text-brand-200">· {m.uf}</span> <Icon name="x" size={12} />
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-ink-400">Nenhum município selecionado — defina o território para buscar.</p>
        )}

        <div className="mt-4">
          <PartidaInput value={f.partida} onChange={f.setPartida} />
        </div>
      </div>

      {/* Pesos do score */}
      <div className="rounded-2xl border border-hairline bg-surface p-3 shadow-card">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
          Pesos do score <Hint text={PESO_SLIDER_HINT} />
        </h4>
        <p className="mt-0.5 text-xs text-ink-400">Quanto cada fator influencia o ranqueamento.</p>
        {(['cnae', 'proximidade', 'porte', 'capital', 'idade'] as const).map((k) => (
          <label key={k} className="mt-3 block">
            <div className="flex justify-between text-xs font-semibold text-ink-600">
              <span className="inline-flex items-center gap-1.5">{PESO_LABEL[k]} <Hint text={PESO_HINT[k]} /></span>
              <span className="tabnums text-brand-600">{f.pesos[k].toFixed(2)}</span>
            </div>
            <input type="range" min={0} max={1} step={0.05} value={f.pesos[k]}
              onChange={(e) => f.setPesos({ ...f.pesos, [k]: Number(e.target.value) })}
              className="mt-1.5 w-full accent-brand-600" />
          </label>
        ))}
      </div>
    </div>
  );
}
