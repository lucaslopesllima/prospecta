// Shared UI primitives — the visual vocabulary of the design system.
// Pages compose these so spacing, radius, color and motion stay consistent.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.tsx';

export const cn = (...xs: (string | false | null | undefined)[]): string => xs.filter(Boolean).join(' ');

/* ── Campo de formulário ───────────────────────────────────
   Fonte única do estilo de input/select/textarea. Existiam 21 cópias literais
   desta string espalhadas por pages/ e lib/ — mudar altura de toque ou estado
   de erro exigia 21 edições, então na prática nunca mudava.
   `text-base sm:text-sm`: abaixo de 16px o iOS dá zoom no foco. Com 16px no
   mobile o zoom não dispara e o pinch-zoom pode continuar liberado (ver o
   viewport no index.html). A altura resultante também passa dos 44px de toque. */
export const inputCls = 'w-full rounded-xl border border-ink-200 bg-surface px-3 py-2.5 text-base text-ink-800 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-200 sm:text-sm';

/* Mesma base, para o campo em estado inválido. */
export const inputErrCls = cn(inputCls, 'border-rose-300 focus:border-rose-400 focus:ring-rose-200');

/* ── Click guard (anti double-click) ──────────────────────
   Wraps an onClick handler: while a returned promise is pending the
   button reports busy and further clicks are ignored, so async actions
   (save, delete, API calls) can't fire twice. Sync handlers pass through. */
type ClickHandler = (e: React.MouseEvent<HTMLButtonElement>) => unknown;
function useClickGuard(onClick?: ClickHandler): { busy: boolean; handleClick?: ClickHandler } {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (!onClick || lock.current) return;
    const r = onClick(e);
    if (r instanceof Promise) {
      lock.current = true;
      setBusy(true);
      void r.finally(() => { lock.current = false; setBusy(false); });
    }
  }, [onClick]);
  return { busy, handleClick: onClick ? handleClick : undefined };
}

/* Bare <button> with the same click guard as Btn but zero styling of its
   own — drop-in replacement for raw <button> elements that fire async
   actions. Disabled (and inert) while the handler's promise is pending. */
export function SafeButton(
  { onClick, disabled, ...rest }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { onClick?: ClickHandler },
): React.JSX.Element {
  const { busy, handleClick } = useClickGuard(onClick);
  return <button {...rest} disabled={disabled || busy} onClick={handleClick} />;
}

/* ── Card ─────────────────────────────────────────────── */
export function Card({ className, children }: { className?: string; children: ReactNode }): React.JSX.Element {
  return <div className={cn('rounded-2xl border border-hairline bg-surface shadow-card', className)}>{children}</div>;
}

/* ── Button ───────────────────────────────────────────── */
type BtnVariant = 'primary' | 'soft' | 'ghost' | 'danger';
const BTN: Record<BtnVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm shadow-brand-600/20',
  soft: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
  ghost: 'text-ink-600 hover:bg-ink-100',
  danger: 'bg-rose-50 text-rose-600 hover:bg-rose-100',
};
export function Btn(
  { variant = 'primary', size = 'md', icon, className, children, onClick, disabled, ...rest }:
  { variant?: BtnVariant; size?: 'sm' | 'md'; icon?: IconName; className?: string; children?: ReactNode; onClick?: ClickHandler }
  & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>,
): React.JSX.Element {
  const { busy, handleClick } = useClickGuard(onClick);
  return (
    <button {...rest} disabled={disabled || busy} onClick={handleClick}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 disabled:opacity-50',
        // piso de toque: `sm` renderiza a 28px, abaixo do mínimo de 44px. No
        // desktop (ponteiro fino) 28px continua confortável, então o piso só
        // vale no mobile.
        size === 'sm' ? 'px-3 py-1.5 text-xs max-sm:min-h-11' : 'px-4 py-2.5 text-sm',
        BTN[variant], className)}>
      {busy
        ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden />
        : icon && <Icon name={icon} size={size === 'sm' ? 15 : 17} />}
      {children}
    </button>
  );
}

/* ── Badge ────────────────────────────────────────────── */
export type Tone = 'brand' | 'success' | 'info' | 'warn' | 'danger' | 'neutral';
const TONE: Record<Tone, string> = {
  brand: 'bg-brand-50 text-brand-700',
  success: 'bg-emerald-50 text-emerald-700',
  info: 'bg-sky-50 text-sky-700',
  warn: 'bg-amber-50 text-amber-700',
  danger: 'bg-rose-50 text-rose-600',
  neutral: 'bg-ink-100 text-ink-600',
};
export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }): React.JSX.Element {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold', TONE[tone], className)}>{children}</span>;
}

/* ── StatCard — the analytics KPI tile ───────────────────── */
export function StatCard(
  { label, value, sub, icon, tone = 'brand' }:
  { label: string; value: ReactNode; sub?: ReactNode; icon: IconName; tone?: Tone },
): React.JSX.Element {
  const ICON_BG: Record<Tone, string> = {
    brand: 'bg-brand-50 text-brand-600',
    success: 'bg-emerald-50 text-emerald-600',
    info: 'bg-sky-50 text-sky-600',
    warn: 'bg-amber-50 text-amber-600',
    danger: 'bg-rose-50 text-rose-600',
    neutral: 'bg-ink-100 text-ink-600',
  };
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-500">{label}</p>
          <p className="tabnums mt-1 text-2xl font-bold tracking-tight text-ink-900">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-ink-400">{sub}</p>}
        </div>
        <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', ICON_BG[tone])}>
          <Icon name={icon} size={20} />
        </span>
      </div>
    </Card>
  );
}

/* ── StatRow — a faixa de indicadores ──────────────────────
   Mesmos números, dois formatos. Cartões a partir de `sm`; abaixo disso uma
   linha compacta de texto. Motivo: em 10 telas a faixa era `grid-cols-2`
   (4 KPIs = 2 fileiras altas, ~200px) e em 3 delas `sm:grid-cols-N` — que
   abaixo de `sm` vira UMA coluna, 4 cartões empilhados, ~400px de rolagem
   antes da lista que o usuário veio ver. */
export function StatRow(
  { items, cols = 4 }: { items: { label: string; value: ReactNode; sub?: ReactNode; icon: IconName; tone?: Tone }[]; cols?: 3 | 4 },
): React.JSX.Element {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-hairline bg-surface px-3 py-2 text-xs text-ink-500 sm:hidden">
        {items.map((s, i) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            {i > 0 && <span className="text-ink-300">·</span>}
            {s.label} <b className="tabnums font-bold text-ink-800">{s.value}</b>
          </span>
        ))}
      </div>
      <div className={cn('hidden gap-3 sm:grid sm:grid-cols-2', cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
        {items.map((s) => <StatCard key={s.label} {...s} />)}
      </div>
    </>
  );
}

/* ── RowActions — ações de uma linha de lista ──────────────
   O layout mais repetido da app (19 arquivos) e o mais hostil ao toque: 4
   ícones de 32px encostados à direita ocupavam 140px fixos, então em 360px
   sobrava quase nada para o nome, e errar o alvo inativava o cliente em vez
   de editá-lo. Aqui: no mobile só a ação primária fica exposta e o resto vai
   para um `⋯` (o Popover que já existe); no desktop tudo continua visível. */
export interface RowAction {
  icon: IconName; label: string; onClick: () => unknown;
  tone?: 'default' | 'danger'; hidden?: boolean;
}
export function RowActions({ actions, primary }: { actions: RowAction[]; primary?: RowAction }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const shown = actions.filter((a) => !a.hidden);
  const all = primary && !primary.hidden ? [primary, ...shown] : shown;
  if (all.length === 0) return <></>;

  const iconBtn = (a: RowAction, key: string): React.JSX.Element => (
    <SafeButton key={key} onClick={a.onClick} title={a.label} aria-label={a.label}
      className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl transition sm:h-8 sm:w-8',
        a.tone === 'danger'
          ? 'text-ink-300 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10'
          : 'text-ink-400 hover:bg-ink-100 hover:text-ink-700')}>
      <Icon name={a.icon} size={17} />
    </SafeButton>
  );

  return (
    <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
      {/* mobile: ação primária (ou a primeira) + overflow */}
      <span className="sm:hidden">{iconBtn(all[0]!, 'primary')}</span>
      {all.length > 1 && (
        <>
          <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)}
            aria-label="Mais ações" aria-haspopup="menu" aria-expanded={open}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-ink-400 transition hover:bg-ink-100 hover:text-ink-700 sm:hidden">
            <Icon name="menu" size={17} />
          </button>
          <Popover open={open} anchorRef={btnRef} onClose={() => setOpen(false)} width={200}>
            {all.slice(1).map((a) => (
              <SafeButton key={a.label} role="menuitem"
                onClick={() => { setOpen(false); return a.onClick(); }}
                className={cn('flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-ink-50',
                  a.tone === 'danger' ? 'text-rose-600' : 'text-ink-700')}>
                <Icon name={a.icon} size={16} className="shrink-0" />{a.label}
              </SafeButton>
            ))}
          </Popover>
        </>
      )}
      {/* desktop: tudo exposto, como antes */}
      <span className="hidden items-center gap-1 sm:flex">{all.map((a, i) => iconBtn(a, String(i)))}</span>
    </div>
  );
}

/* ── ChipBar — o que está filtrado agora ───────────────────
   Estado do filtro visível SEM abrir o painel. Rola na horizontal no mobile;
   cada chip remove o próprio critério, e tocar no rótulo reabre a seção que
   o criou. */
export interface FilterChip { key: string; label: ReactNode; onRemove?: () => void; onClick?: () => void }
export function ChipBar({ chips, onClear }: { chips: FilterChip[]; onClear?: () => void }): React.JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <div className="no-scrollbar flex items-center gap-1.5 overflow-x-auto py-0.5">
      {chips.map((c) => (
        <span key={c.key}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand-600 py-1 pl-3 pr-1 text-xs font-semibold text-white">
          <button type="button" onClick={c.onClick} className={cn('max-w-[42vw] truncate sm:max-w-none', !c.onClick && 'cursor-default')}>
            {c.label}
          </button>
          {c.onRemove && (
            <button type="button" onClick={c.onRemove} aria-label="Remover filtro"
              className="grid h-6 w-6 place-items-center rounded-full text-white/70 transition hover:bg-white/20 hover:text-white">
              <Icon name="x" size={12} />
            </button>
          )}
        </span>
      ))}
      {onClear && (
        <button type="button" onClick={onClear}
          className="shrink-0 whitespace-nowrap px-2 py-1 text-xs font-semibold text-ink-500 transition hover:text-ink-800">
          Limpar
        </button>
      )}
    </div>
  );
}

/* ── usePanels — Filtros / Indicadores ─────────────────────
   Prospecção, Funil e Pedidos tinham cada um a MESMA dupla de estados, as
   MESMAS duas chaves de localStorage e os MESMOS dois efeitos de persistência
   — três cópias, e nada impedindo os dois painéis abertos ao mesmo tempo
   (que é o estado que o storage devolvia na visita seguinte, empurrando o
   primeiro resultado para 880px abaixo do topo). Abrir um agora fecha o outro. */
export type PanelName = 'filtros' | 'kpis';
export function usePanels(scope: string, inicial: PanelName | null = 'kpis'): {
  aberto: PanelName | null; toggle: (p: PanelName) => void; abrir: (p: PanelName) => void; fechar: () => void;
} {
  const key = `${scope}:panel`;
  const [aberto, setAberto] = useState<PanelName | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === 'filtros' || raw === 'kpis') return raw;
      if (raw === 'none') return null;
    } catch { /* storage indisponível */ }
    return inicial;
  });
  useEffect(() => {
    try { localStorage.setItem(key, aberto ?? 'none'); } catch { /* storage indisponível */ }
  }, [key, aberto]);
  const toggle = useCallback((p: PanelName) => setAberto((v) => (v === p ? null : p)), []);
  const abrir = useCallback((p: PanelName) => setAberto(p), []);
  const fechar = useCallback(() => setAberto(null), []);
  return { aberto, toggle, abrir, fechar };
}

/* ── FilterPanel — o painel de filtros nos dois tamanhos ───
   Desktop: acordeão inline, como sempre foi. Mobile: folha pelo rodapé, para
   o painel COBRIR a lista em vez de empurrá-la — com um rodapé fixo que conta
   os resultados ao vivo, então aplicar e fechar viram o mesmo gesto. */
export function FilterPanel(
  { open, onClose, titulo = 'Filtros', acao, children }: {
    open: boolean; onClose: () => void; titulo?: string;
    acao?: { label: string; onClick: () => void; disabled?: boolean };
    children: ReactNode;
  },
): React.JSX.Element {
  return (
    <>
      <div className="hidden sm:block">
        <Collapse open={open} duration={200}>{children}</Collapse>
      </div>
      <div className="sm:hidden">
        {open && (
          <Modal open title={titulo} onClose={onClose} width="lg"
            footer={
              <>
                <Btn variant="ghost" type="button" onClick={onClose}>Fechar</Btn>
                {acao && (
                  <Btn type="button" icon="search" disabled={acao.disabled}
                    onClick={() => { acao.onClick(); onClose(); }} className="flex-1 sm:flex-none">
                    {acao.label}
                  </Btn>
                )}
              </>
            }>
            {children}
          </Modal>
        )}
      </div>
    </>
  );
}

/* ── Collapse — barra de filtros / faixa de KPIs ──────────
   Anima a altura pelo truque do grid (0fr -> 1fr). O overflow-hidden é
   obrigatório enquanto anima, senão o conteúdo vaza da caixa que está
   crescendo; mas depois de aberto ele precisa sair, porque dropdowns dos
   filtros (busca de CNAE, endereço) abrem para fora e ficavam cortados
   pelo que vem abaixo. */
export function Collapse(
  { open, duration = 300, children }: { open: boolean; duration?: number; children: ReactNode },
): React.JSX.Element {
  const [animating, setAnimating] = useState(false);
  const montado = useRef(false);
  useEffect(() => {
    if (!montado.current) { montado.current = true; return; }
    setAnimating(true);
    const t = window.setTimeout(() => setAnimating(false), duration);
    return () => clearTimeout(t);
  }, [open, duration]);
  const dur = { transitionDuration: `${duration}ms` };
  return (
    <div className={cn('grid transition-[grid-template-rows] ease-in-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')} style={dur}>
      <div className={cn('transition-opacity ease-in-out',
        open && !animating ? 'overflow-visible' : 'overflow-hidden',
        open ? 'opacity-100' : 'opacity-0')} style={dur}>
        {children}
      </div>
    </div>
  );
}

/* ── Recolher acordeão ao clicar fora ──────────────────────
   Usado pela barra de filtros: clicar no conteúdo da tela (board do funil,
   lista de empresas) fecha o painel sem precisar voltar no botão. Vai no
   mousedown do documento, como o resto dos dropdowns.
   `ignoreSelector` marca o próprio botão de abrir/fechar — sem ele, o mousedown
   fecharia e o click logo em seguida reabriria. */
export function useCollapseOnOutside(
  open: boolean, close: () => void,
  boxRef: React.RefObject<HTMLElement | null>, ignoreSelector?: string,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      // nó já desmontado (item de lista que sumiu) não conta como "fora"
      if (!t || !t.isConnected) return;
      if (boxRef.current?.contains(t)) return;
      if (ignoreSelector && t instanceof Element && t.closest(ignoreSelector)) return;
      closeRef.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, boxRef, ignoreSelector]);
}

/* ── Segmented control ─────────────────────────────────── */
export function Segmented<T extends string>(
  { value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: IconName }[] },
): React.JSX.Element {
  return (
    <div className="inline-flex rounded-xl bg-ink-100 p-1 text-sm font-medium">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={cn('inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 transition-colors',
            value === o.value ? 'bg-surface text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-700')}>
          {o.icon && <Icon name={o.icon} size={15} />}{o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Page header (section bar atop each route) ──────────── */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold tracking-tight text-ink-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

/* ── States ───────────────────────────────────────────── */
export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-brand-500" />
      {label ?? 'Carregando…'}
    </div>
  );
}
export function EmptyState({ icon, title, hint }: { icon: IconName; title: string; hint?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-ink-100 text-ink-400"><Icon name={icon} size={24} /></span>
      <p className="text-sm font-medium text-ink-600">{title}</p>
      {hint && <p className="max-w-xs text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

/* ── Tooltip de ajuda ───────────────────────────────────────
   Ícone "?" que explica um conceito. O balão sai em portal no body com
   position:fixed — dentro do fluxo ele era cortado pelo overflow-hidden dos
   acordeões/scrollers (z-index não resolve clipping). Abre sempre para cima
   do ícone, com clamp horizontal para não vazar da viewport. Sem title nativo
   (duplicaria o balão); o texto vai em aria-label para leitor de tela. */
const HINT_W = 224; // w-56

export function Hint({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const half = HINT_W / 2;
    const left = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8);
    setPos({ top: r.top - 6, left });
  }, []);
  const hide = useCallback(() => setPos(null), []);

  return (
    <span className={cn('inline-flex align-middle', className)}>
      <button type="button" ref={ref} aria-label={text}
        // só informativo: não deve submeter nem "fazer" nada ao clicar
        onClick={(e) => e.preventDefault()}
        onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}
        className="grid h-4 w-4 place-items-center rounded-full text-ink-300 transition hover:text-brand-600 focus:text-brand-600 focus:outline-none">
        <Icon name="alertCircle" size={13} />
      </button>
      {pos !== null && createPortal(
        <span role="tooltip" style={{ top: pos.top, left: pos.left, width: HINT_W }}
          className="pointer-events-none fixed z-[100] -translate-x-1/2 -translate-y-full rounded-lg bg-ink-900 px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-ink-50 shadow-pop">
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

/* ── Popover — menu flutuante ancorado ─────────────────────
   Sai em portal no body com position:fixed pelo mesmo motivo do Hint: no
   fluxo normal qualquer scroller/acordeão ancestral corta o menu, e z-index
   não resolve clipping. Ancora no elemento de referência, vira para cima
   quando não cabe embaixo e reposiciona no scroll/resize. Traz o próprio
   backdrop de fechar — clique fora fecha, e como o menu fica ACIMA dele os
   itens continuam clicáveis (fechar no mousedown do documento mataria o
   click do item antes de ele disparar). */
export function Popover(
  { open, anchorRef, onClose, width, align = 'right', z = 1500, className, children }: {
    open: boolean;
    anchorRef: React.RefObject<HTMLElement | null>;
    onClose: () => void;
    width: number;
    align?: 'left' | 'right';
    z?: number;
    className?: string;
    children: ReactNode;
  },
): React.JSX.Element | null {
  const [pos, setPos] = useState<{ top: number; left: number; maxH: number; cima: boolean } | null>(null);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const GAP = 4;
    const MARGEM = 8;
    const place = (): void => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const abaixo = window.innerHeight - r.bottom - GAP - MARGEM;
      const acima = r.top - GAP - MARGEM;
      const cima = abaixo < 180 && acima > abaixo;
      const bruto = align === 'right' ? r.right - width : r.left;
      setPos({
        top: cima ? r.top - GAP : r.bottom + GAP,
        left: Math.min(Math.max(bruto, MARGEM), Math.max(MARGEM, window.innerWidth - width - MARGEM)),
        maxH: Math.max(120, cima ? acima : abaixo),
        cima,
      });
    };
    place();
    // capture: pega o scroll de qualquer ancestral (coluna do funil, canvas do
    // chat), não só o da janela.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, anchorRef, width, align, onClose]);

  if (!open || pos === null) return null;
  return createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: z - 1 }} onClick={onClose} />
      <div role="menu"
        style={{ top: pos.top, left: pos.left, width, maxHeight: pos.maxH, zIndex: z, transform: pos.cima ? 'translateY(-100%)' : undefined }}
        className={cn('fixed overflow-auto rounded-xl border border-ink-200 bg-surface py-1 shadow-pop', className)}>
        {children}
      </div>
    </>,
    document.body,
  );
}

/* ── Modal / bottom sheet ──────────────────────────────────
   Substitui as 25 cascas `fixed inset-0 grid place-items-center` escritas à
   mão. O que cada cópia esquecia e aqui vem de graça:

   • ALTURA. Nenhuma tinha limite: form alto com o teclado do celular aberto
     empurrava o botão Salvar para fora da tela e a tarefa ficava impossível
     de concluir. Aqui o corpo rola dentro de `max-h`, cabeçalho e rodapé ficam
     fixos, e o Salvar é sempre alcançável.
   • MOBILE. Abaixo de `sm` ancora no rodapé como folha de largura cheia — o
     polegar alcança, e é para onde o olho já vai.
   • ESCAPE. Só 2 das 25 fechavam no Esc.
   • SCROLL DE FUNDO. Travado enquanto aberto, senão o conteúdo atrás rola
     junto e o usuário perde o lugar.
   • DESCARTE ACIDENTAL. O véu fechava no `click`, então soltar o mouse fora
     depois de selecionar texto DENTRO do form fechava e perdia tudo. Aqui só
     fecha quando o toque começa E termina no véu.
   • EMPILHAMENTO. z-index vinha de 50 a 2100 sem regra e modal-sobre-modal
     funcionava por sorte; `level` dá a escala.

   `footer` fica grudado embaixo; passe as ações por ele em vez de no corpo. */
const MODAL_W = {
  sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-lg',
  xl: 'sm:max-w-xl', '2xl': 'sm:max-w-2xl', '4xl': 'sm:max-w-4xl',
} as const;

export function Modal(
  { open = true, title, subtitle, onClose, width = 'md', level = 0, footer, className, children }: {
    open?: boolean;
    title?: ReactNode;
    subtitle?: ReactNode;
    onClose: () => void;
    width?: keyof typeof MODAL_W;
    level?: number;      // 0 = base; +1 para cada modal aberto sobre outro
    footer?: ReactNode;
    className?: string;
    children: ReactNode;
  },
): React.JSX.Element | null {
  // O véu só fecha se o gesto COMEÇOU nele. Sem isso, arrastar para selecionar
  // texto dentro do form e soltar fora descarta o que foi digitado.
  const downOnScrim = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    // trava o scroll do fundo enquanto a camada está aberta
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;
  const z = 2000 + level * 10;

  return createPortal(
    <div role="dialog" aria-modal="true" style={{ zIndex: z }}
      onPointerDown={(e) => { downOnScrim.current = e.target === e.currentTarget; }}
      onPointerUp={(e) => { if (downOnScrim.current && e.target === e.currentTarget) onClose(); }}
      className="fixed inset-0 flex items-end justify-center bg-scrim backdrop-blur-[2px] [animation:scrimIn_.15s_ease-out] sm:items-center sm:p-4">
      <div onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          'flex w-full flex-col overflow-hidden border border-hairline bg-glass shadow-pop backdrop-blur-xl',
          // mobile: folha colada no rodapé, cantos só em cima, respeita o notch
          'max-h-[92dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] [animation:sheetIn_.22s_cubic-bezier(.32,.72,0,1)]',
          // desktop: diálogo centrado
          'sm:max-h-[88dvh] sm:rounded-2xl sm:pb-0 sm:[animation:dialogIn_.16s_ease-out]',
          MODAL_W[width], className)}>

        {/* pega-folha: só no mobile, sinaliza que a camada é arrastável/descartável */}
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-ink-300 sm:hidden" />

        {(title || subtitle) && (
          <div className="flex shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-3">
            <div className="min-w-0">
              {title && <h3 className="truncate text-sm font-bold text-ink-900">{title}</h3>}
              {subtitle && <p className="mt-0.5 text-xs text-ink-400">{subtitle}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Fechar"
              className="-mr-1 grid h-9 w-9 shrink-0 place-items-center rounded-xl text-ink-400 transition hover:bg-ink-100 hover:text-ink-700">
              <Icon name="x" size={18} />
            </button>
          </div>
        )}

        {/* o corpo é quem rola — cabeçalho e rodapé ficam */}
        <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-4', !(title || subtitle) && 'pt-4', !footer && 'pb-4')}>
          {children}
        </div>

        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-hairline px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ── Mini score bar (explainable recommendation) ────────── */
export function ScoreBar({ label, value, className }: { label: string; value: number; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex-1', className)}>
      <div className="flex justify-between text-[10px] font-medium text-ink-500"><span>{label}</span><span className="tabnums">{value.toFixed(2)}</span></div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(value * 200, 100)}%` }} />
      </div>
    </div>
  );
}
