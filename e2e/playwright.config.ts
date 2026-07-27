import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

// Stack sobe via docker compose (ver package.json "stack:up") — Playwright roda
// no host contra localhost:5173 (dev, HMR) ou :8080 (build de produção, projeto
// "pwa" — só lá tem service worker registrado, ver client/vite.config.ts
// devOptions.enabled:false).
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const PWA_BASE_URL = process.env.E2E_PWA_BASE_URL ?? 'http://localhost:8091';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /20-pwa-offline/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /07-agenda\/checkin/,
    },
    {
      // Só esse projeto roda contra o build de produção (service worker ativo).
      name: 'pwa',
      use: { ...devices['Desktop Chrome'], baseURL: PWA_BASE_URL },
      testMatch: /20-pwa-offline/,
    },
  ],
  // Sem webServer: a stack (db/app/web/mailpit/stub) sobe via `npm run stack:up`.
});
