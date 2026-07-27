// Só roda no projeto "pwa" (playwright.config.ts) — build de produção do
// client (service worker ativo; `vite dev` tem devOptions.enabled:false) servido
// pelo Fastify em :8091 (docker-compose.e2e.yml, serviço app-pwa). Rodar com
// `npm run test:pwa` (builda a imagem antes).
import { test, expect } from '@playwright/test';
import { registerOrg, setSession } from '../../fixtures/auth.ts';
import { ApiClient } from '../../fixtures/api.ts';
import { db } from '../../fixtures/index.ts';
import { rowFor } from '../../helpers/row.ts';

test.use({ geolocation: { latitude: -23.5505, longitude: -46.6333 }, permissions: ['geolocation'] });

test.describe('PWA — offline', () => {
  test('service worker registra no build de produção', async ({ page, request }) => {
    const session = await registerOrg(request, 'pwa-sw-ready');
    await setSession(page, session);
    await page.goto('/');
    const ready = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.ready;
      return true;
    });
    expect(ready).toBe(true);
  });

  test('agenda carregada online continua acessível offline; check-in offline sincroniza ao reconectar', async ({ page, request, context }) => {
    test.setTimeout(60_000);
    const session = await registerOrg(request, 'pwa-offline-checkin');
    const api = new ApiClient(request, session);
    const company = await db.seedCompany({ uf: 'SP' });
    // "Registrar visita" só aparece com company_id vinculado (podeVisitar em Agenda.tsx).
    const activity = await api.createActivity({ titulo: 'Visita PWA offline E2E', start_at: new Date().toISOString(), tipo: 'visita', company_id: company.id });

    await setSession(page, session);
    await context.grantPermissions(['geolocation']);
    await page.goto('/agenda');
    await page.getByRole('button', { name: 'Lista' }).click();
    await page.waitForLoadState('networkidle');
    await page.evaluate(async () => { if ('serviceWorker' in navigator) await navigator.serviceWorker.ready; });
    await expect(page.getByText('Visita PWA offline E2E')).toBeVisible();

    // No 1º load o SW registra mas ainda NÃO controla a página, então o fetch de
    // /api/activities não passa pelo SW e não é cacheado. Um reload online (a view
    // "Lista" persiste) faz o SW assumir e cachear a resposta via NetworkFirst.
    await page.reload();
    await expect(page.getByText('Visita PWA offline E2E')).toBeVisible();
    // Confirma que a resposta está de fato no cache antes de cortar a rede — senão
    // o reload offline corre com o cache vazio e a lista vem vazia (flake).
    await expect.poll(async () => page.evaluate(async () => {
      const c = await caches.open('rs-api-campo');
      const keys = await c.keys();
      return keys.some((r) => r.url.includes('/api/activities'));
    }), { timeout: 10_000 }).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText(/Você está offline|Offline —/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Visita PWA offline E2E')).toBeVisible({ timeout: 15_000 });

    const row = rowFor(page, 'Visita PWA offline E2E', page.getByRole('button', { name: 'Registrar visita' }));
    await row.getByRole('button', { name: 'Registrar visita' }).click();
    await page.getByRole('button', { name: 'Check-in' }).click();
    await expect(page.getByText(/aguardando/)).toBeVisible({ timeout: 15_000 });

    await context.setOffline(false);
    await expect(page.getByText(/Sincronizando/)).toBeVisible({ timeout: 20_000 }).catch(() => undefined);

    await expect.poll(async () => {
      const r = await request.get(`/api/activities?limit=500`, { headers: { authorization: `Bearer ${session.token}` } });
      const body = (await r.json()) as { activities: { id: number; checkin_lat: number | null }[] };
      const a = body.activities.find((x) => x.id === activity.id);
      return a?.checkin_lat ?? null;
    }, { timeout: 30_000 }).not.toBeNull();
  });
});
