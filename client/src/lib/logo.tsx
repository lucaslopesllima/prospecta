// Marca oficial (marca/rovva-icon.svg + wordmark de marca/logo.svg), inline em
// SVG: herda o tamanho do layout, não custa request extra e mantém o gradiente
// exato da identidade (Rovva Blue → Blue 700). Não trocar as cores do gradiente
// nem distorcer — ver marca/IDENTIDADE.md.
import { useId } from 'react';

const BLUE_700 = '#2448BC';

// Símbolo: tile do território + rota que sai do pin e sobe até a seta.
export function LogoMark({ size = 32, className = '' }: { size?: number; className?: string }): React.JSX.Element {
  const gid = useId();
  return (
    <svg
      width={size} height={size} viewBox="0 0 512 512" fill="none"
      role="img" aria-label="Rovva" className={className}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#597EF8" />
          <stop offset="1" stopColor={BLUE_700} />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="120" fill={`url(#${gid})`} />
      <path d="M150 360 C 300 360 232 205 366 196" stroke="#ffffff" strokeWidth="46" strokeLinecap="round" />
      <circle cx="150" cy="360" r="42" fill="#ffffff" />
      <circle cx="150" cy="360" r="18" fill={BLUE_700} />
      <path d="M312 176 L376 196 L344 258" stroke="#ffffff" strokeWidth="46" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Wordmark: o duplo-vv sai destacado na cor primária, amarrando com o símbolo.
// `accent` permite o tom claro (brand-400) quando o texto está sobre fundo dark.
export function LogoWord({ className = '', accent = 'text-brand-500' }: { className?: string; accent?: string }): React.JSX.Element {
  return (
    <span className={className}>
      Ro<span className={accent}>vv</span>a
    </span>
  );
}
