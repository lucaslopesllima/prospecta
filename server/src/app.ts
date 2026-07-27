import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import websocket from '@fastify/websocket';
import helmet from '@fastify/helmet';
import { pool } from './db.ts';
import { config } from './config.ts';
import { authRoutes } from './routes/auth.ts';
import { municipiosRoutes } from './routes/municipios.ts';
import { recommendRoutes } from './routes/recommend.ts';
import { cnaeRoutes } from './routes/cnae.ts';
import { relationshipRoutes } from './routes/relationships.ts';
import { stageRoutes } from './routes/stages.ts';
import { activityRoutes } from './routes/activities.ts';
import { representedRoutes } from './routes/represented.ts';
import { cadastroRoutes } from './routes/cadastros.ts';
import { privateLabelRoutes } from './routes/privateLabels.ts';
import { companyRoutes } from './routes/companies.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { accountRoutes } from './routes/account.ts';
import { financeRoutes } from './routes/finance.ts';
import { vehicleRoutes } from './routes/vehicles.ts';
import { routePlanRoutes } from './routes/routes.ts';
import { userRoutes } from './routes/users.ts';
import { groupRoutes } from './routes/groups.ts';
import { auditRoutes } from './routes/audit.ts';
import { priceTableRoutes } from './routes/priceTables.ts';
import { orderRoutes } from './routes/orders.ts';
import { carrierRoutes } from './routes/carriers.ts';
import { commissionRoutes } from './routes/commissions.ts';
import { goalRoutes } from './routes/goals.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { reportRoutes } from './routes/reports.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { sampleRequestRoutes } from './routes/sampleRequests.ts';
import { taxRoutes } from './routes/tax.ts';
import { emailScheduleRoutes } from './routes/emailSchedules.ts';
import { settingsRoutes } from './routes/settings.ts';
import { whatsappRoutes } from './routes/whatsapp.ts';
import { webhookRoutes } from './routes/webhooks.ts';

// Monta a app com todas as rotas de API, sem listen e sem estáticos —
// index.ts (produção) adiciona o resto; os testes usam app.inject().
// Async porque o plugin de rate limit precisa estar registrado ANTES das rotas
// que o referenciam via config.rateLimit.
export async function buildApp(opts: { logger?: boolean; authRateLimitMax?: number } = {}): Promise<FastifyInstance> {
  // Produção: nível configurável, sem log por request (ruído/custo) e com redact
  // dos campos sensíveis. Dev mantém o logger padrão; testes passam logger:false.
  const isProd = process.env.NODE_ENV === 'production';
  const logger = opts.logger ?? (isProd
    ? { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.query.token'] }
    : true);
  // trustProxy como número de saltos (não `true`): confia só nos últimos N hops do
  // X-Forwarded-For. `true` confiaria em XFF forjado por qualquer cliente, burlando
  // o rate-limit por IP dos endpoints de auth. Ver config.trustProxyHops.
  const app = Fastify({ logger, trustProxy: config.trustProxyHops, disableRequestLogging: isProd });

  // Security headers (CSP, nosniff, frame-ancestors, HSTS em prod). App e API são
  // same-origin; a CSP libera só os hosts externos realmente usados pelo client:
  // tiles do OpenStreetMap (Leaflet), Nominatim/BrasilAPI/OSRM (geocode e rotas)
  // e ViaCEP (CEP -> endereço nos formulários de conta e de partida das rotas).
  // 'unsafe-inline' em style: Leaflet e Tailwind injetam estilos inline; blob: em
  // img/worker: avatares/impressão via Blob URL e o service worker do PWA.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://tile.openstreetmap.org'],
        'connect-src': ["'self'", 'https://nominatim.openstreetmap.org', 'https://brasilapi.com.br', 'https://viacep.com.br', 'https://router.project-osrm.org'],
        'worker-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'frame-ancestors': ["'self'"],
        'base-uri': ["'self'"],
      },
    },
    // HSTS só faz sentido sob HTTPS (produção atrás do proxy TLS).
    hsts: isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
    // COEP off: bloquearia tiles/recursos cross-origin sem CORP; não precisamos de
    // cross-origin isolation aqui.
    crossOriginEmbedderPolicy: false,
  });
  // Compressão HTTP global (br/gzip) — respostas JSON grandes (listas, dashboard)
  // encolhem bem; threshold evita comprimir payload pequeno. Registrado antes das rotas.
  await app.register(compress, { global: true, encodings: ['br', 'gzip'], threshold: 1024 });
  // global:false — só as rotas que declaram config.rateLimit (autenticação) limitam.
  await app.register(rateLimit, { global: false });
  // WebSocket: espelho de chat WhatsApp ao vivo (rota /api/whatsapp/ws).
  await app.register(websocket);
  app.decorate('authRateLimitMax', opts.authRateLimitMax ?? config.authRateLimitMax);

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // Config pública lida pela tela de login antes de haver token: hoje só diz se o
  // cadastro está aberto (SIGNUP_ENABLED). Nada sensível pode entrar aqui.
  app.get('/api/config', async () => ({ signup_enabled: config.signupEnabled }));

  authRoutes(app);
  municipiosRoutes(app);
  recommendRoutes(app);
  cnaeRoutes(app);
  relationshipRoutes(app);
  stageRoutes(app);
  activityRoutes(app);
  representedRoutes(app);
  cadastroRoutes(app);
  privateLabelRoutes(app);
  companyRoutes(app);
  catalogRoutes(app);
  accountRoutes(app);
  financeRoutes(app);
  vehicleRoutes(app);
  routePlanRoutes(app);
  userRoutes(app);
  groupRoutes(app);
  auditRoutes(app);
  priceTableRoutes(app);
  orderRoutes(app);
  carrierRoutes(app);
  commissionRoutes(app);
  goalRoutes(app);
  dashboardRoutes(app);
  reportRoutes(app);
  notificationRoutes(app);
  sampleRequestRoutes(app);
  taxRoutes(app);
  emailScheduleRoutes(app);
  settingsRoutes(app);
  whatsappRoutes(app);
  webhookRoutes(app);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    authRateLimitMax: number;
  }
}
