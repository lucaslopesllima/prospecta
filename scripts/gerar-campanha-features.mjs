import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../e2e/node_modules/playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const campaignDir = path.join(root, 'marketing/conteudo/campanha-features-2026-08-13');
const sourcePath = path.join(campaignDir, 'texto.md');
const postsDir = path.join(campaignDir, 'posts');
const source = await fs.readFile(sourcePath, 'utf8');
const darkLogo = `data:image/svg+xml;base64,${Buffer.from(await fs.readFile(path.join(root, 'marca/rovva-logo-dark.svg'))).toString('base64')}`;
const lightLogo = `data:image/svg+xml;base64,${Buffer.from(await fs.readFile(path.join(root, 'marca/logo.svg'))).toString('base64')}`;

const blocks = [...source.matchAll(/^Dia (\d+) — ([^\n]+)\n([\s\S]*?)(?=^Dia \d+ —|(?![\s\S]))/gm)].map((match) => ({
  day: Number(match[1]),
  label: match[2].trim(),
  raw: match[0].trim(),
  content: match[3].trim(),
}));

if (blocks.length === 0) throw new Error('Nenhum post encontrado no arquivo de campanha.');

const slugify = (value) => value
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  .slice(0, 42);

const clean = (value) => value.replace(/\s+/g, ' ').trim();

function extractCarousel(block) {
  const slides = [...block.content.matchAll(/Slide (\d+) — ([\s\S]*?)(?=\n\nSlide \d+ —|$)/g)].map((match) => {
    const number = Number(match[1]);
    const raw = clean(match[2]);
    if (number === 1) return { number, heading: raw.replace(/^Capa\s+/i, ''), body: '' };
    const parts = raw.match(/^(CTA(?:\s*\([^)]*\))?|A dor|A rotina|A consequ[êe]ncia|A solu[çc][ãa]o|A virada|O custo(?: escondido| invisível)?|O problema(?: real)?|O outro extremo|A cena|A realidade|O risco|O desafio|A pergunta|A recapitula[çc][ãa]o|O padr[ãa]o|A proposta)\s+(.+)$/i);
    return parts
      ? { number, heading: clean(parts[1]).replace(/\s*\([^)]*\)/, ''), body: clean(parts[2]) }
      : { number, heading: `Ponto ${number}`, body: raw };
  });
  if (slides.length < 2) throw new Error(`Carrossel do dia ${block.day} sem slides suficientes.`);
  return slides;
}

function extractSingle(block) {
  const template = /template a preencher|depende de dado real|depoimento autorizado/i.test(block.content);
  const parts = block.content.split(/\n\n+/).map(clean).filter(Boolean);
  const usable = parts.filter((part) => !/^(Formato:|Estrutura sugerida|Nota de uso:)/i.test(part));
  const headingPart = usable.find((part) => /^(Frase principal|Texto|Mito|Antes)\s+/i.test(part)) ?? usable[0] ?? block.label;
  const heading = clean(headingPart.replace(/^(Frase principal|Texto|Mito|Antes)\s+/i, ''));
  const body = usable
    .filter((part) => part !== headingPart)
    .map((part) => clean(part.replace(/^(Apoio|CTA(?:\s*\([^)]*\))?|Realidade|Depois|Como a Rovva ajuda)\s+/i, '')))
    .filter(Boolean);
  return { heading: template ? 'Depoimento em validação' : heading, body, template };
}

function theme(day, index) {
  const coverModes = ['dark', 'blue', 'light'];
  const innerModes = ['light', 'dark', 'blue', 'light', 'dark'];
  return index === 0 ? coverModes[(day - 1) % coverModes.length] : innerModes[(index - 1) % innerModes.length];
}

function esc(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slideHtml({ mode, day, current, total, eyebrow, heading, body, final, template }) {
  const logo = mode === 'light' ? lightLogo : darkLogo;
  const size = heading.length > 62 ? ' long' : heading.length > 38 ? ' medium' : '';
  const paragraphs = body ? body.split(/\n+/).map((line) => `<p>${esc(line)}</p>`).join('') : '';
  return `<section class="slide ${mode}${final ? ' final' : ''}">
    <div class="route route-a"></div><div class="route route-b"></div>
    <header><img src="${logo}" alt="Rovva"><span>DIA ${String(day).padStart(2, '0')} · ${current}/${total}</span></header>
    <main>
      <div class="eyebrow">${esc(eyebrow)}</div>
      ${template ? '<div class="template">DADO REAL NECESSÁRIO</div>' : ''}
      <div class="bar"></div>
      <h1 class="${size.trim()}">${esc(heading)}</h1>
      ${paragraphs ? `<div class="body">${paragraphs}</div>` : ''}
    </main>
    <footer><span>ROVVA</span><span>${final ? 'Do território ao pedido pago' : '@rovva.app'}</span></footer>
  </section>`;
}

function documentHtml({ title, slides }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>
    *{box-sizing:border-box} body{margin:0;background:#d9dde9;font-family:Inter,Arial,sans-serif}.slide{position:relative;width:1080px;height:1350px;overflow:hidden;padding:74px 82px;display:flex;flex-direction:column;background:#f7f8fb;color:#0d1220}.slide.dark{background:#0d1220;color:#fff}.slide.blue{background:#3e66ea;color:#fff}.slide.light{background:#f7f8fb;color:#0d1220}.slide:after{content:"";position:absolute;inset:20px;border:1px solid currentColor;opacity:.12;border-radius:30px;pointer-events:none}header,footer{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between}header img{width:172px;height:52px;object-fit:contain;object-position:left center}header span{font-size:16px;letter-spacing:.18em;font-weight:700;opacity:.62}main{position:relative;z-index:2;display:flex;flex:1;flex-direction:column;justify-content:center;max-width:845px}.eyebrow{font-size:16px;font-weight:800;letter-spacing:.25em;text-transform:uppercase;color:#ff6a2b;margin-bottom:24px}.blue .eyebrow{color:#fff}.bar{height:6px;width:84px;border-radius:9px;background:#ff6a2b;margin:0 0 30px}.blue .bar{background:#0d1220}.light .bar{background:#3e66ea}h1{font-size:92px;line-height:.96;letter-spacing:-.055em;margin:0;font-weight:900;max-width:850px}h1.medium{font-size:76px}h1.long{font-size:64px;line-height:1.01}.body{font-size:30px;line-height:1.36;letter-spacing:-.018em;font-weight:500;margin-top:38px;max-width:830px}.body p{margin:0 0 20px}.body p:first-child{font-weight:700}.final main{max-width:860px}.final h1{font-size:76px}.final .body{font-size:33px;font-weight:700}.route{position:absolute;border:4px solid;opacity:.16;border-radius:999px;transform:rotate(-24deg)}.route-a{width:760px;height:450px;right:-280px;top:110px;border-left-color:transparent;border-bottom-color:transparent}.route-b{width:960px;height:570px;left:-470px;bottom:-245px;border-right-color:transparent;border-top-color:transparent}.light .route{color:#3e66ea}.dark .route{color:#fff}.blue .route{color:#fff}.template{align-self:flex-start;border:2px solid #ff6a2b;color:#ff6a2b;background:rgba(255,255,255,.08);padding:10px 14px;font-size:15px;font-weight:900;letter-spacing:.13em;margin:0 0 25px}footer{padding-top:30px;border-top:1px solid currentColor;font-size:17px;font-weight:800;letter-spacing:.12em;opacity:.78}footer span:last-child{font-weight:600;letter-spacing:.04em;text-transform:none}@media print{body{background:transparent}}</style></head><body>${slides.join('')}</body></html>`;
}

function caption(block, carousel, single) {
  const title = carousel ? carousel[0].heading : single.heading;
  const context = carousel
    ? carousel.slice(1, 3).map((slide) => slide.body).filter(Boolean).join(' ')
    : single.body.slice(0, 2).join(' ');
  const cta = carousel ? 'Arraste para o lado e confere.' : 'O que disso aparece na sua rotina comercial?';
  const disclaimer = single?.template ? '\n\n⚠️ Este é um template. Substitua pelos dados e depoimento autorizados antes de publicar.' : '';
  return `${title}\n\n${context}\n\n${cta}\n\nA Rovva ajuda representantes a encontrar empresas, organizar oportunidades e levar cada conversa até o pedido.\n\n#Rovva #RepresentanteComercial #RepresentacaoComercial #ProspecçãoB2B #VendasB2B #GestãoComercial #CRM #FunilDeVendas #VendasExternas #Prospecção #TerritórioComercial #Pedidos #Comissões #RotinaComercial${disclaimer}\n`;
}

async function render(folder, count) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });
    await page.goto(`file://${path.join(folder, 'carrossel.html')}`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const slides = page.locator('.slide');
    for (let index = 0; index < count; index += 1) {
      await slides.nth(index).screenshot({ path: path.join(folder, 'instagram', `slide-${String(index + 1).padStart(2, '0')}.png`) });
    }
  } finally {
    await browser.close();
  }
}

for (const block of blocks) {
  const carousel = /carrossel/i.test(block.label) ? extractCarousel(block) : null;
  const single = carousel ? null : extractSingle(block);
  const title = carousel ? carousel[0].heading : single.heading;
  const folder = path.join(postsDir, `dia-${String(block.day).padStart(2, '0')}-${slugify(block.label.replace(/carrossel|post único|dica rápida|prova social|pergunta aberta|antes \/ depois|mito vs realidade/gi, '')) || 'post'}`);
  const count = carousel ? carousel.length : 1;
  const slides = carousel
    ? carousel.map((slide, index) => slideHtml({
      mode: theme(block.day, index), day: block.day, current: index + 1, total: count,
      eyebrow: index === 0 ? 'Rovva · rotina comercial' : slide.heading,
      heading: index === 0 ? slide.heading : (slide.body || slide.heading),
      body: index === 0 ? 'Do território ao pedido pago.' : '',
      final: index === count - 1, template: false,
    }))
    : [slideHtml({
      mode: theme(block.day, 0), day: block.day, current: 1, total: 1,
      eyebrow: 'Rovva · rotina comercial', heading: single.heading,
      body: single.body.slice(0, 3).join('\n'), final: false, template: single.template,
    })];

  await fs.mkdir(path.join(folder, 'instagram'), { recursive: true });
  await fs.writeFile(path.join(folder, 'texto.md'), `${block.raw}\n`);
  await fs.writeFile(path.join(folder, 'carrossel.html'), documentHtml({ title: `Rovva — Dia ${block.day}`, slides }));
  await fs.writeFile(path.join(folder, 'legenda.md'), caption(block, carousel, single));
  await fs.writeFile(path.join(folder, 'render.js'), `const { chromium } = require('../../../../e2e/node_modules/playwright');\nconst path = require('node:path');\n(async () => {\n  const browser = await chromium.launch({ headless: true });\n  try {\n    const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 1 });\n    await page.goto('file://' + path.join(__dirname, 'carrossel.html'));\n    const slides = page.locator('.slide');\n    for (let i = 0; i < await slides.count(); i += 1) await slides.nth(i).screenshot({ path: path.join(__dirname, 'instagram', 'slide-' + String(i + 1).padStart(2, '0') + '.png') });\n  } finally { await browser.close(); }\n})();\n`);
  if (single?.template) await fs.writeFile(path.join(folder, 'OBSERVACAO.md'), 'Template de prova social. Substituir marcadores por dado ou depoimento real e autorizado antes de publicar.\n');
  await render(folder, count);
  process.stdout.write(`Dia ${String(block.day).padStart(2, '0')}: ${count} imagem(ns)\n`);
}
