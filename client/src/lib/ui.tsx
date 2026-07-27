// Shared UI primitives — the visual vocabulary of the design system.
// Pages compose these so spacing, radius, color and motion stay consistent.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.tsx';

export const cn = (...xs: (string | false | null | undefined)[]): string => xs.filter(Boolean).join(' ');

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
  return <div className={cn('rounded-2xl border border-ink-200/70 bg-surface shadow-card', className)}>{children}</div>;
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
        size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2.5 text-sm',
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
