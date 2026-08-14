// Renderização para sites que só montam conteúdo depois de executar JavaScript.
// Lightpanda atende primeiro via CDP; Chromium local cobre incompatibilidade/WAF.
// CAPTCHA/desafio não é resolvido: continua sendo informado como bloqueio.
import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { hostSeguro } from './site.ts';

export interface PaginaRenderizada {
  url: string;
  html: string;
  status: number;
  bloqueado: boolean;
}

export type MotorRenderizacao = 'lightpanda' | 'chromium';

const TIMEOUT_NAVEGACAO_MS = 8_000;
const TIMEOUT_REDE_MS = 3_000;
const BLOQUEIO_HTTP = new Set([401, 403, 405, 406, 429]);
const RE_DESAFIO = /(cf-chl-|cloudflare.{0,80}challenge|<title[^>]*>[^<]*(?:just a moment|attention required|captcha)|verifique que voc[eê] [ée] humano|checking your browser)/i;
const CAMINHOS_CHROMIUM = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter((p): p is string => Boolean(p));

let chromiumPendente: Promise<Browser> | null = null;
let chromiumIndisponivel = false;
let chromiumUsos = 0;
let chromiumIdle: NodeJS.Timeout | null = null;

function manterChromiumAtivo(): void {
  if (chromiumIdle) clearTimeout(chromiumIdle);
  chromiumIdle = null;
}

function liberarChromiumDepois(): void {
  if (chromiumUsos !== 0 || !chromiumPendente) return;
  manterChromiumAtivo();
  chromiumIdle = setTimeout(() => {
    const atual = chromiumPendente;
    chromiumPendente = null;
    chromiumIdle = null;
    if (atual) void atual.then((browser) => browser.close()).catch(() => undefined);
  }, 60_000);
  chromiumIdle.unref();
}

async function abrirLightpanda(): Promise<Browser | null> {
  const endpoint = process.env.LIGHTPANDA_CDP_URL;
  if (!endpoint) return null;
  // Cada conexão CDP ganha contexto padrão isolado no servidor Lightpanda.
  // Contextos adicionais ainda não cobrem toda API CDP; por isso não reutiliza.
  try { return await chromium.connectOverCDP(endpoint, { timeout: 3_000 }); } catch { return null; }
}

async function abrirChromium(): Promise<Browser | null> {
  if (chromiumIndisponivel) return null;
  manterChromiumAtivo();
  if (!chromiumPendente) {
    const executablePath = CAMINHOS_CHROMIUM.find(existsSync);
    if (!executablePath) {
      chromiumIndisponivel = true;
      return null;
    }
    const pendente = chromium.launch({
      executablePath,
      headless: true,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    chromiumPendente = pendente;
    pendente.then((browser) => browser.on('disconnected', () => {
      if (chromiumPendente === pendente) chromiumPendente = null;
    })).catch(() => {
      if (chromiumPendente === pendente) chromiumPendente = null;
      chromiumIndisponivel = true;
    });
  }
  try { return await chromiumPendente; } catch { return null; }
}

export async function buscarPaginaRenderizada(
  url: string,
  baseSpa?: string,
  motor: MotorRenderizacao = 'chromium',
): Promise<PaginaRenderizada | null> {
  let inicial: URL;
  try { inicial = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(inicial.protocol) || !(await hostSeguro(inicial.hostname))) return null;

  const navegador = motor === 'lightpanda' ? await abrirLightpanda() : await abrirChromium();
  if (!navegador) return null;
  if (motor === 'chromium') chromiumUsos++;
  let contexto: BrowserContext | null = null;
  let pagina: Page | null = null;
  const hosts = new Map<string, Promise<boolean>>();

  try {
    contexto = motor === 'lightpanda'
      ? navegador.contexts()[0] ?? null
      : await navegador.newContext({ javaScriptEnabled: true, locale: 'pt-BR', serviceWorkers: 'block' });
    if (!contexto) return null;
    pagina = await contexto.newPage();
    await pagina.setExtraHTTPHeaders({ 'X-Rovva-Crawler': 'Rovva/1.0 (+https://rovva.tech/bot)' });
    await pagina.route('**/*', async (route) => {
      const req = route.request();
      if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) {
        await route.abort();
        return;
      }
      let alvo: URL;
      try { alvo = new URL(req.url()); } catch { await route.abort(); return; }
      if (alvo.protocol === 'data:' || alvo.protocol === 'blob:') { await route.continue(); return; }
      if (alvo.protocol !== 'http:' && alvo.protocol !== 'https:') { await route.abort(); return; }
      let seguro = hosts.get(alvo.hostname);
      if (!seguro) {
        seguro = hostSeguro(alvo.hostname);
        hosts.set(alvo.hostname, seguro);
      }
      if (await seguro) await route.continue();
      else await route.abort();
    });

    let resposta = await pagina.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVEGACAO_MS });
    await pagina.waitForLoadState('networkidle', { timeout: TIMEOUT_REDE_MS }).catch(() => undefined);
    let status = resposta?.status() ?? 0;

    // S3/CloudFront costuma devolver index.html com 404 para rota interna. Abrir
    // URL diretamente faz router voltar à home. Carrega raiz válida e navega
    // pelo link renderizado (ou History API quando não existe link clicável).
    if (baseSpa && status >= 400) {
      let base: URL | null = null;
      try { base = new URL(baseSpa); } catch { /* base inválida */ }
      if (base && base.origin === inicial.origin) {
        resposta = await pagina.goto(base.toString(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAVEGACAO_MS });
        await pagina.waitForLoadState('networkidle', { timeout: TIMEOUT_REDE_MS }).catch(() => undefined);
        if ((resposta?.status() ?? 500) < 400) {
          await pagina.evaluate((destino) => {
            const g = globalThis as unknown as {
              document: { querySelectorAll(s: string): Iterable<{ href: string; click(): void }> };
              location: { href: string };
              URL: typeof URL;
              history: { pushState(data: object, unused: string, url: string): void };
              dispatchEvent(event: object): void;
              PopStateEvent: new (type: string) => object;
            };
            const link = Array.from(g.document.querySelectorAll('a[href]'))
              .find((a) => new g.URL(a.href, g.location.href).toString() === destino);
            if (link) link.click();
            else {
              g.history.pushState({}, '', destino);
              g.dispatchEvent(new g.PopStateEvent('popstate'));
            }
          }, inicial.toString());
          await pagina.waitForLoadState('networkidle', { timeout: TIMEOUT_REDE_MS }).catch(() => undefined);
          status = 200;
        }
      }
    }

    const html = await pagina.content();
    return {
      url: pagina.url(),
      html,
      status,
      bloqueado: BLOQUEIO_HTTP.has(status) || RE_DESAFIO.test(html),
    };
  } catch {
    return null;
  } finally {
    await pagina?.close().catch(() => undefined);
    if (motor === 'lightpanda') await navegador.close().catch(() => undefined);
    else {
      await contexto?.close().catch(() => undefined);
      chromiumUsos--;
      liberarChromiumDepois();
    }
  }
}
