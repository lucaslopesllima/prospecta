# Rovva — Identidade visual

## Conceito

O símbolo é um **map tile** (o território) com uma **rota ascendente** que parte de um
pin e sobe até uma seta. Traduz a tese do produto: percorrer o território e **subir** —
do primeiro contato ao pedido. Geométrico, limpo, escalável, sem fonte externa.

Metáfora única: **rota sobre o território** (não misturar com mira, radar, etc.).

## Logo

- `logo.svg` — símbolo + wordmark, cor (uso principal).
- `logo-mono.svg` — versão monocromática (ink) para fundos claros / 1 cor.
- `favicon.svg` — só o símbolo em quadrado arredondado (app icon, aba do navegador).

No wordmark, o duplo-**vv** é destacado na cor primária, amarrando com o símbolo.

### Área de proteção e uso mínimo
- Margem livre em volta = altura do símbolo ÷ 2.
- Tamanho mínimo do símbolo: 24px (favicon) / wordmark completo: 120px de largura.

### O que não fazer
- Não esticar/distorcer, não trocar as cores do gradiente, não aplicar sombra pesada.
- Não colocar o wordmark ink sobre fundo escuro (usar versão clara — inverter o `fill`).
- Não recriar o símbolo com outra metáfora.

## Paleta

| Token | HEX | Uso |
|---|---|---|
| **Rovva Blue** (primária) | `#3E66EA` | marca, CTAs, links, destaque |
| Blue 700 (escuro) | `#2448BC` | hover, gradiente, texto sobre claro |
| Blue 50 (tint) | `#ECF0FD` | fundos de destaque, badges |
| **Signal Orange** (acento) | `#FF6A2B` | pins no mapa, marcadores de ação, detalhe |
| Ink (texto/dark) | `#0D1220` | títulos, fundo dark |
| Slate 600 | `#475069` | corpo de texto |
| Slate 400 | `#8A93A6` | texto secundário, legendas |
| BG | `#FFFFFF` / `#F7F8FB` | fundo claro / seções alternadas |
| Success | `#16A34A` | positivo, "ativa", meta batida |
| Warning | `#F59E0B` | atenção, pendência |
| Error | `#DC2626` | erro, perdido |

**Justificativa:** azul cobalto passa **confiança B2B** e lê bem sobre mapa; o laranja-sinal
dá **energia e ação** e marca os pontos no território sem competir com o azul. Ink quase-preto
mantém contraste AA em texto.

### Tokens Tailwind v4 (a stack já usa Tailwind 4)

```css
@theme {
  --color-brand-50:  #ECF0FD;
  --color-brand-500: #3E66EA;
  --color-brand-700: #2448BC;
  --color-accent-500:#FF6A2B;
  --color-ink:       #0D1220;
  --color-slate-600: #475069;
  --color-slate-400: #8A93A6;
}
```

## Tipografia

- **Display + corpo:** **Inter** (gratuita, open source). Fallback: `-apple-system,
  'Segoe UI', Helvetica, Arial, sans-serif`. Um só tipo, pesos variados, mantém coeso e
  evita dependência externa (a landing usa o stack de sistema para ser autossuficiente).
- Escala (rem): 3.5 / 2.5 / 1.75 / 1.25 / 1 / 0.875.
- Títulos: peso 800, `letter-spacing: -0.02em`. Corpo: peso 400/500.

## Aplicações

- **App:** favicon → `client/index.html`, cor primária nos botões/links (Tailwind tokens acima).
- **Mapa (Leaflet):** pins em Signal Orange, cluster/território em Rovva Blue.
- **Social:** avatar = `favicon.svg`; capa usa símbolo + tagline sobre Ink.
