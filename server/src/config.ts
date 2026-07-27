// Central config from env. No secrets hardcoded.

// work_mem é interpolado em SET LOCAL (não há bind param para SET) — valida o
// formato no boot para que nenhum valor fora de "NNNkB/MB/GB" chegue ao SQL.
export const workMem = (raw: string): string => {
  if (!/^\d+(?:kB|MB|GB)$/.test(raw)) {
    throw new Error(`RECOMMEND_WORK_MEM inválido: "${raw}" (esperado ex.: 64MB)`);
  }
  return raw;
};

export const INSECURE_JWT_DEFAULT = 'dev-insecure-secret-change-me';

// Em produção (Dockerfile seta NODE_ENV=production) abortar o boot se o
// JWT_SECRET estiver ausente ou no default inseguro. Esse segredo assina os JWT
// (auth.ts) E deriva a chave AES das senhas SMTP (crypto.ts) — cair no default
// permitiria forjar token de admin de qualquer org e decifrar credenciais.
export const requireSecret = (secret: string, nodeEnv: string | undefined): string => {
  if (nodeEnv === 'production' && secret === INSECURE_JWT_DEFAULT) {
    throw new Error('JWT_SECRET ausente ou inseguro em produção — defina um segredo forte antes do boot');
  }
  return secret;
};
const jwtSecretEnv = requireSecret(process.env.JWT_SECRET ?? INSECURE_JWT_DEFAULT, process.env.NODE_ENV);

// Webhook da Evolution não usa JWT (máquina-a-máquina). Sem um token compartilhado
// o endpoint fica aberto: qualquer um que saiba o nome da instância (org_<id>,
// previsível) injeta mensagens forjadas em qualquer org. Em produção, exigir o
// token OU a integração desligada (EVOLUTION_API_URL vazio) — nunca ligado e aberto.
export const requireWebhookToken = (token: string, evolutionUrl: string, nodeEnv: string | undefined): string => {
  if (nodeEnv === 'production' && evolutionUrl !== '' && token === '') {
    throw new Error('WHATSAPP_WEBHOOK_TOKEN ausente em produção com Evolution ligada — defina um token antes do boot');
  }
  return token;
};

export const config = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  // Nº de proxies reversos à frente da app. Fastify confia apenas nos últimos N
  // saltos do X-Forwarded-For — impede spoof de XFF (que burlaria o rate-limit por
  // IP). Padrão 1 (um proxy no Docker/compose). 0 = ignora XFF (dev direto).
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/rs',
  jwtSecret: jwtSecretEnv,
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7),
  // path to the built client (Dockerfile copies it here); empty disables static serving in dev.
  clientDir: process.env.CLIENT_DIR ?? '',
  // raised per-session for the recommendation query (large in-memory sort).
  recommendWorkMem: workMem(process.env.RECOMMEND_WORK_MEM ?? '64MB'),
  // rate limit dos endpoints de autenticação (por IP). Generoso o bastante para
  // uso real, apertado o bastante para inviabilizar brute force.
  authRateLimitMax: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
  authRateLimitWindow: process.env.AUTH_RATE_LIMIT_WINDOW ?? '1 minute',
  // Evolution API (gateway WhatsApp não oficial). URL interna do container e a
  // API key global (cria/opera instâncias). Vazio = integração desligada (os
  // endpoints respondem 503). webhookUrl é onde a Evolution entrega os eventos
  // (no docker aponta de volta pro serviço app); token opcional valida o POST.
  evolutionApiUrl: process.env.EVOLUTION_API_URL ?? '',
  evolutionApiKey: process.env.EVOLUTION_API_KEY ?? '',
  whatsappWebhookUrl: process.env.WHATSAPP_WEBHOOK_URL ?? '',
  whatsappWebhookToken: requireWebhookToken(
    process.env.WHATSAPP_WEBHOOK_TOKEN ?? '',
    process.env.EVOLUTION_API_URL ?? '',
    process.env.NODE_ENV,
  ),
  // Diretório (volume) onde a mídia descriptografada do WhatsApp é gravada. Setado
  // = grava em disco e guarda só o caminho no banco; vazio = mantém base64 no
  // Postgres (comportamento legado). Ver mediaStore.ts.
  whatsappMediaDir: process.env.WHATSAPP_MEDIA_DIR ?? '',
  // Serviços externos de geocode/roteamento — hosts públicos por padrão; e2e
  // aponta pra um stub local via env para não depender de rede/rate-limit externo.
  nominatimUrl: process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org',
  brasilApiUrl: process.env.BRASILAPI_URL ?? 'https://brasilapi.com.br',
  osrmUrl: process.env.OSRM_URL ?? 'https://router.project-osrm.org',
  // Cadastro público (POST /api/auth/register). Desligado responde 403 e o client
  // esconde a aba "Criar conta". Produção sobe com SIGNUP_ENABLED=false (fixado no
  // docker-compose.prod.yml); dev/test/e2e ficam ligados — toda a suíte cria seu
  // tenant por essa rota. Só 'false' desliga; qualquer outro valor mantém ligado.
  signupEnabled: (process.env.SIGNUP_ENABLED ?? 'true') !== 'false',
};
