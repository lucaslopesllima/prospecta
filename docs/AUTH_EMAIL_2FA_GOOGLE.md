# Confirmação de e-mail, 2FA (TOTP) e Login com Google

Plano de implementação para os três recursos de autenticação, escrito contra o código
que existe hoje (`server/src/auth.ts`, `server/src/routes/auth.ts`, `client/src/lib/auth.tsx`,
`client/src/pages/Login.tsx`). Nada aqui foi implementado ainda — este documento é o roteiro.

---

## 0. Ponto de partida (o que já existe)

| Peça | Onde | Observação |
| --- | --- | --- |
| Hash de senha scrypt `salt:hash` | `server/src/auth.ts` | `hashPassword` / `verifyPassword` / `verifyAgainstDummy` (defesa de timing) |
| JWT HS256 via `jose` | `server/src/auth.ts` | claims: `sub`, `org`, `role`, `ver`; TTL 7d (`JWT_TTL_SECONDS`) |
| Invalidação de sessão | `users.token_version` | incrementa na troca/reset de senha; validado em `authorizeToken` |
| Cifra simétrica at rest | `server/src/crypto.ts` | AES-256-GCM, chave derivada do `JWT_SECRET` — reusar para o segredo TOTP |
| SMTP | `server/src/smtp.ts` | **por org** (`org_smtp_settings`), usado só para e-mail de prospecção |
| Rate limit por IP | `@fastify/rate-limit`, `config.authRateLimit*` | `global:false`; só rotas que declaram `config.rateLimit` |
| CSP | `server/src/app.ts` (helmet) | `script-src 'self'` — decisivo na escolha do fluxo Google (ver §3) |
| Contexto de auth no client | `client/src/lib/auth.tsx` | token no `localStorage` via `api.ts`, usuário espelhado em `rs_user` |
| Migrações | `server/migrations/NNN_*.sql` | runner idempotente `server/scripts/migrate.ts` |
| Testes | `vitest` + `app.inject`, helpers em `server/test/helpers.ts` | rodar com Postgres+PostGIS no docker |

Três lacunas bloqueiam qualquer um dos recursos:

1. **Não há SMTP de plataforma.** `org_smtp_settings` é do tenant e não existe no momento do
   cadastro. Confirmação de e-mail, reenvio e alertas de segurança precisam de um remetente
   próprio do produto (§1.1).
2. **`verifyToken` não checa o propósito do token.** Hoje qualquer JWT assinado com o
   `JWT_SECRET` vira sessão. 2FA e Google introduzem tokens intermediários (pré-2FA, troca de
   código) — sem uma claim `typ` validada, um token intermediário funcionaria como sessão
   completa. **Isso deve ser feito antes** dos outros passos (§1.2).
3. **`users.senha_hash` é `NOT NULL`.** Conta criada só via Google não tem senha (§3.4).

---

## 0.1 Pré-requisito A — SMTP de plataforma

Novo módulo `server/src/mailer.ts` (não mexer em `smtp.ts`, que continua sendo o SMTP do tenant):

```ts
// server/src/mailer.ts
// SMTP da PLATAFORMA (Rovva), distinto do SMTP por org de smtp.ts: e-mails
// transacionais de conta (confirmação de cadastro, 2FA ligado/desligado, reset).
// Config por env — não há linha no banco porque é do produto, não do tenant.
import nodemailer from 'nodemailer';
import { config } from './config.ts';

let transporter: nodemailer.Transporter | null = null;

export function mailerEnabled(): boolean {
  return config.platformSmtpHost !== '';
}

export async function sendSystemEmail(msg: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  if (!mailerEnabled()) throw new Error('SMTP de plataforma não configurado');
  transporter ??= nodemailer.createTransport({
    pool: true,
    host: config.platformSmtpHost,
    port: config.platformSmtpPort,
    secure: config.platformSmtpSecure,
    auth: config.platformSmtpUser ? { user: config.platformSmtpUser, pass: config.platformSmtpPass } : undefined,
  });
  await transporter.sendMail({
    from: `${config.platformFromName} <${config.platformFromEmail}>`,
    to: msg.to, subject: msg.subject, text: msg.text, html: msg.html,
  });
}
```

Novos campos em `server/src/config.ts`:

```ts
  platformSmtpHost: process.env.PLATFORM_SMTP_HOST ?? '',
  platformSmtpPort: Number(process.env.PLATFORM_SMTP_PORT ?? 587),
  platformSmtpSecure: process.env.PLATFORM_SMTP_SECURE === 'true',
  platformSmtpUser: process.env.PLATFORM_SMTP_USER ?? '',
  platformSmtpPass: process.env.PLATFORM_SMTP_PASS ?? '',
  platformFromEmail: process.env.PLATFORM_FROM_EMAIL ?? 'nao-responda@rovva.com.br',
  platformFromName: process.env.PLATFORM_FROM_NAME ?? 'Rovva',
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:5173', // usado nos links dos e-mails e no redirect_uri do Google
```

Em teste, `PLATFORM_SMTP_HOST` fica vazio: `mailerEnabled()` é false, `sendSystemEmail` não é
chamado e os testes leem o token direto do banco (§1.6). Em produção, validar no boot no mesmo
estilo de `requireSecret`: se `NODE_ENV=production` e `EMAIL_VERIFICATION_REQUIRED=true` com
host vazio → abortar (senão ninguém consegue confirmar o cadastro).

## 0.2 Pré-requisito B — claim `typ` no JWT

`server/src/auth.ts`:

```ts
export type TokenPurpose = 'access' | 'mfa' | 'exchange';

export async function signToken(claims: TokenClaims, purpose: TokenPurpose = 'access', ttl = `${config.jwtTtlSeconds}s`): Promise<string> {
  return new SignJWT({ org: claims.orgId, role: claims.role, ver: claims.tokenVersion, typ: purpose })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(claims.userId))
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret);
}

export async function verifyToken(token: string, expected: TokenPurpose = 'access'): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
  // Tokens antigos (emitidos antes desta versão) não têm `typ` — tratados como
  // 'access' durante a janela de compatibilidade (TTL de 7 dias). Remover o
  // fallback ?? 'access' depois de 7 dias em produção.
  if (String(payload.typ ?? 'access') !== expected) throw new AuthError('token de propósito inválido');
  return { userId: Number(payload.sub), orgId: Number(payload.org), role: String(payload.role), tokenVersion: Number(payload.ver ?? 0) };
}
```

`authorizeToken` continua chamando `verifyToken(token)` (default `'access'`), então WebSocket,
`?token=` de mídia e `requireAuth` ganham a proteção de graça.

---

## 1. Confirmação de e-mail

### 1.1 Modelo de dados — `server/migrations/069_email_verification.sql`

```sql
-- 069 Confirmação de e-mail do cadastro. O token NUNCA é gravado em claro:
-- guardamos sha256(token) — vazamento de backup/dump não permite confirmar contas
-- alheias. Uma linha por emissão (histórico + auditoria de reenvio); a confirmação
-- consome a linha (used_at) e carimba users.email_verificado_em.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verificado_em timestamptz;

-- Contas que já existiam antes desta feature entram como verificadas: exigir
-- confirmação retroativa derrubaria o acesso de todo mundo em produção.
UPDATE users SET email_verificado_em = now() WHERE email_verificado_em IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       text   NOT NULL,           -- alvo da confirmação (suporta troca de e-mail)
  token_hash  text   NOT NULL,           -- sha256 hex do token enviado por e-mail
  expira_em   timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS evt_hash_idx ON email_verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS evt_user_idx ON email_verification_tokens (user_id, created_at DESC);
```

> Contas novas nascem com `email_verificado_em IS NULL`; o `UPDATE` acima só cobre o legado.

### 1.2 Emissão do token — `server/src/emailVerification.ts`

```ts
import { randomBytes, createHash } from 'node:crypto';
import { query, one } from './db.ts';
import { config } from './config.ts';
import { sendSystemEmail, mailerEnabled } from './mailer.ts';

const TTL_HORAS = 24;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// Emite um token de confirmação e dispara o e-mail. Devolve o token em claro só
// para os testes (em produção ele só existe dentro do e-mail).
export async function issueVerification(userId: number, email: string): Promise<string> {
  const token = randomBytes(32).toString('base64url'); // 256 bits — não adivinhável
  await query(
    `INSERT INTO email_verification_tokens (user_id, email, token_hash, expira_em)
     VALUES ($1, $2, $3, now() + interval '${TTL_HORAS} hours')`,
    [userId, email, sha256(token)],
  );
  const link = `${config.appBaseUrl}/verificar-email?token=${token}`;
  if (mailerEnabled()) {
    await sendSystemEmail({
      to: email,
      subject: 'Confirme seu e-mail — Rovva',
      text: `Confirme seu cadastro: ${link}\n\nO link expira em ${TTL_HORAS} horas.`,
    });
  }
  return token;
}

// Consome um token. Idempotente por linha (used_at) e à prova de corrida: o
// UPDATE condicional só acerta uma vez.
export async function consumeVerification(token: string): Promise<{ userId: number } | null> {
  const rows = await query<{ user_id: string; email: string }>(
    `UPDATE email_verification_tokens
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expira_em > now()
      RETURNING user_id, email`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  await query(
    `UPDATE users SET email_verificado_em = now() WHERE id = $1 AND email = $2`,
    [row.user_id, row.email],
  );
  return { userId: Number(row.user_id) };
}
```

### 1.3 Rotas — `server/src/routes/auth.ts`

- `POST /api/auth/register` — depois do `COMMIT`, chamar `issueVerification(user.id, normEmail)`
  **fora da transação** e com `try/catch` (falha de SMTP não pode desfazer o cadastro; o usuário
  reenvia). A resposta continua devolvendo `token` + `user`, agora com `email_verificado: false`.
- `POST /api/auth/verify-email` `{ token }` — sem autenticação, com `authLimit`. `200 {ok:true}` /
  `400 {error:'token inválido ou expirado'}`.
- `POST /api/auth/resend-verification` — com `requireAuth`, rate limit próprio (**máx. 3 por hora
  por usuário**, contando linhas em `email_verification_tokens` na última hora — o limite por IP
  não basta). Não reenvia se já verificado.
- `GET /api/auth/me` e o login passam a devolver `email_verificado: boolean`.
- `PATCH /api/account` (troca de e-mail, `server/src/routes/account.ts:56`) — ao trocar o e-mail,
  zerar `email_verificado_em` e emitir novo token para o novo endereço.

### 1.4 Política de bloqueio

Escolher uma; recomendo a **(b)**:

| | Comportamento | Prós/contras |
| --- | --- | --- |
| (a) Rígida | Login recusado até confirmar | Mais seguro; qualquer problema de entregabilidade vira ticket de suporte no dia 1 |
| **(b) Carência (recomendado)** | Login liberado; banner persistente; após `EMAIL_VERIFICATION_GRACE_DAYS` (padrão 7) escritas bloqueiam com `403 email_nao_verificado` | Sem atrito no onboarding, e ainda assim obriga a confirmar |
| (c) Só banner | Nunca bloqueia | Não impede cadastro com e-mail de terceiro |

Implementação da (b): preHandler `requireVerifiedEmail`, empilhado **depois** de `requireAuth`
nas rotas de escrita (o `authorizeToken` já lê a linha de `users` — adicionar
`email_verificado_em` ao SELECT existente e levar em `AuthClaims`, sem query extra):

```ts
export async function requireVerifiedEmail(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const c = req.auth!;
  if (c.emailVerificadoEm) return;
  const graceMs = config.emailVerificationGraceDays * 86_400_000;
  if (Date.now() - c.contaCriadaEm < graceMs) return;
  return reply.code(403).send({ error: 'email_nao_verificado' });
}
```

(`contaCriadaEm` exige `users.created_at`; se a coluna não existir, adicionar na 069 com
`DEFAULT now()` — o legado já entra verificado, então o backfill não importa.)

### 1.5 Client

- Rota pública `/verificar-email` (`client/src/pages/VerifyEmail.tsx`): lê `?token=`, faz o POST,
  mostra sucesso/erro e um botão "reenviar" quando logado.
- Banner no layout autenticado quando `user.email_verificado === false`, com "Reenviar e-mail"
  (throttle no botão + toast, reusando `lib/toast.tsx`).
- `User` em `client/src/lib/auth.tsx` ganha `email_verificado?: boolean`.
- Erro `403 email_nao_verificado` em `lib/api.ts` → toast dedicado apontando para o banner, em
  vez da mensagem genérica.

### 1.6 Testes (`server/test/routes-auth-email.test.ts`)

Sem SMTP em teste, ler o token do banco:

```ts
const tok = await one<{ token_hash: string }>(
  'SELECT token_hash FROM email_verification_tokens WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [s.user.id]);
```

Como só o hash é gravado, expor `issueVerification` (que devolve o token em claro) e chamá-la
direto no teste, ou fazer o registro devolver o token quando `NODE_ENV === 'test'` — prefira a
primeira: nada de código condicional a ambiente no caminho de produção.

Casos: token válido confirma; token reusado → 400; token expirado → 400 (`UPDATE ... expira_em =
now() - interval '1 hour'`); token de outro usuário não confirma o meu; reenvio acima do limite →
429; escrita depois da carência sem confirmar → 403; e-mail trocado volta a `NULL`.

---

## 2. 2FA — TOTP (RFC 6238) + códigos de recuperação

### 2.1 Decisão de dependências

TOTP é HMAC-SHA1 sobre um contador — dá para implementar em ~40 linhas com `node:crypto`, sem
dependência nova (coerente com o resto do projeto, que evita libs). O **QR code**, sim, pede
dependência: `qrcode` (~1 dep, gera SVG/dataURL no server). Alternativa sem dep: mostrar só a
chave em base32 para digitação manual — pior UX, mas viável no MVP. Recomendo `qrcode`.

### 2.2 Migração — `server/migrations/070_two_factor.sql`

```sql
-- 070 2FA TOTP. O segredo fica cifrado (AES-256-GCM de src/crypto.ts, mesma
-- chave derivada do JWT_SECRET usada nas senhas SMTP) — dump do banco sozinho
-- não permite gerar códigos. last_step barra replay: o mesmo código de 30s não
-- vale duas vezes (relevante contra phishing em tempo real).

CREATE TABLE IF NOT EXISTS user_totp (
  user_id     bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc  text NOT NULL,             -- iv:tag:cipher (crypto.ts)
  confirmado_em timestamptz,             -- NULL = setup iniciado mas não confirmado
  last_step   bigint,                    -- último passo de 30s aceito
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Códigos de recuperação: 10 por usuário, hash scrypt (mesmo formato de senha),
-- consumo único. Sem eles, perder o celular = perder a conta.
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at  timestamptz
);
CREATE INDEX IF NOT EXISTS urc_user_idx ON user_recovery_codes (user_id) WHERE used_at IS NULL;

-- Política por org: admin pode exigir 2FA de todo mundo do escritório.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS exigir_2fa boolean NOT NULL DEFAULT false;
```

### 2.3 `server/src/totp.ts`

```ts
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PASSO = 30;   // segundos por código
const DIGITOS = 6;
const JANELA = 1;   // aceita [-1, +1] passos: tolera relógio dessincronizado

export function gerarSegredo(): string {           // base32 de 20 bytes (160 bits, recomendação da RFC 4226)
  const buf = randomBytes(20);
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s: string): Buffer {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(c);
    if (idx < 0) throw new Error('base32 inválido');
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function codigoNoPasso(segredoB32: string, passo: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(passo));
  const h = createHmac('sha1', base32Decode(segredoB32)).update(counter).digest();
  const off = h[h.length - 1] & 0x0f;                       // dynamic truncation (RFC 4226 §5.4)
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

// Devolve o passo aceito (para gravar em last_step) ou null. Comparação em tempo
// constante — o código tem só 6 dígitos, não vale entregar oráculo de timing.
export function verificarTotp(segredoB32: string, codigo: string, agoraMs = Date.now(), lastStep?: number | null): number | null {
  const atual = Math.floor(agoraMs / 1000 / PASSO);
  for (let d = -JANELA; d <= JANELA; d++) {
    const passo = atual + d;
    if (lastStep != null && passo <= lastStep) continue;    // replay do mesmo código (ou anterior)
    const esperado = Buffer.from(codigoNoPasso(segredoB32, passo));
    const recebido = Buffer.from(codigo.padStart(DIGITOS, '0').slice(0, DIGITOS));
    if (esperado.length === recebido.length && timingSafeEqual(esperado, recebido)) return passo;
  }
  return null;
}

export function otpauthUri(segredoB32: string, email: string, issuer = 'Rovva'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${segredoB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
```

`agoraMs` injetável = teste determinístico (mesmo padrão de `processDueEmails(now)` em `email.ts`).

### 2.4 Fluxo de ativação (usuário já logado)

1. `POST /api/auth/2fa/setup` (requireAuth) — gera segredo, grava `user_totp` com
   `confirmado_em = NULL` (upsert: refazer o setup substitui o segredo pendente), devolve
   `{ secret, otpauth_uri, qr_svg }`. **Não ativa nada ainda.**
2. `POST /api/auth/2fa/confirm` `{ codigo }` — valida contra o segredo pendente. Sucesso:
   `confirmado_em = now()`, gera 10 códigos de recuperação (`randomBytes(5).toString('hex')`,
   hash com `hashPassword`), devolve os códigos **uma única vez** e envia e-mail de aviso
   ("2FA ativado na sua conta"). Falha: 400, sem ativar.
3. `POST /api/auth/2fa/disable` `{ senha, codigo }` — exige senha atual **e** um código TOTP
   válido (ou de recuperação). Apaga `user_totp` + códigos, **incrementa `token_version`**
   (derruba todas as sessões) e envia e-mail de aviso.
4. `GET /api/auth/2fa/status` — `{ ativo, tem_codigos_restantes: n }`.

Todas com rate limit (`authLimit`); `confirm` e `disable` também com trava por usuário —
5 tentativas erradas em 15 min → 429 (contador em memória por processo é aceitável no MVP de
instância única; se escalar para múltiplas réplicas, mover para uma tabela `auth_attempts`).

### 2.5 Fluxo de login com 2FA

`POST /api/auth/login`, depois de validar senha e `ativo`:

```ts
const totp = await one<{ confirmado_em: string | null }>('SELECT confirmado_em FROM user_totp WHERE user_id = $1', [user.id]);
if (totp?.confirmado_em) {
  // Token de propósito 'mfa': 5 min, NÃO autoriza nenhuma rota (verifyToken
  // valida typ). Só serve como prova de que a senha já foi conferida.
  const mfaToken = await signToken({ userId: user.id, orgId: user.org_id, role: user.role, tokenVersion: user.token_version }, 'mfa', '5m');
  return reply.code(200).send({ mfa_required: true, mfa_token: mfaToken });
}
```

`POST /api/auth/login/2fa` `{ mfa_token, codigo }` (com `authLimit`):
- `verifyToken(mfa_token, 'mfa')`;
- revalida `ativo` e `token_version` (a senha pode ter sido trocada nesses 5 min);
- `codigo` com 6 dígitos → TOTP (`verificarTotp`, gravando `last_step`); 10 hex → código de
  recuperação (`verifyPassword` contra cada `code_hash` não usado, marcando `used_at`; avisar
  por e-mail e sinalizar no client quando restarem ≤ 2);
- sucesso → emite o token `'access'` normal e devolve o mesmo payload `{ token, user }` do login.

**Detalhe importante:** a resposta de login com `mfa_required` não pode incluir dado nenhum do
usuário além do necessário — nada de nome/org/permissões antes do segundo fator.

Política da org: se `organizations.exigir_2fa` e o usuário não tem 2FA confirmado, o login
devolve `{ mfa_setup_required: true, setup_token }` (token `'exchange'` de 15 min que autoriza
**só** `/api/auth/2fa/setup` e `/confirm`), e o client leva direto para o assistente.

### 2.6 Client

- `Login.tsx`: quando `login()` devolve `mfa_required`, trocar o formulário por um passo
  "código de verificação" (input de 6 dígitos, `inputMode="numeric"`, `autoComplete="one-time-code"`)
  com link "usar código de recuperação". `lib/auth.tsx` ganha `loginMfa(codigo)` e guarda o
  `mfa_token` em estado de React (**nunca no localStorage**).
- `Account.tsx` (ou `Settings.tsx`): cartão "Verificação em duas etapas" — status, botão ativar
  (QR + campo de confirmação + tela de códigos de recuperação com "copiar/baixar"), botão desativar.
- `Settings.tsx` (admin, conta escritório): switch "Exigir 2FA de todos os usuários".

### 2.7 Testes (`server/test/routes-auth-2fa.test.ts`)

Unitários de `totp.ts`: vetores da RFC 6238 (segredo `GEZDGNBVGY3TQOJQ` = "12345678901234567890"
em base32; em `t=59` o código SHA1 é `287082`), janela ±1 aceita, `last_step` barra replay,
base32 inválido lança.

Integração: setup → confirm → login devolve `mfa_required` sem `token`; `mfa_token` **não** abre
`/api/auth/me` (401 pelo `typ`); código errado → 400; código de recuperação funciona uma vez só;
disable exige senha + código e invalida sessões antigas (token anterior → 401).

---

## 3. Login com Google

### 3.1 Escolha do fluxo: Authorization Code + PKCE no servidor

Duas opções:

| | Google Identity Services (botão JS no client) | **Authorization Code no servidor (recomendado)** |
| --- | --- | --- |
| CSP | Exige `script-src https://accounts.google.com` + `frame-src` — afrouxa a CSP restrita atual | Nenhuma mudança de CSP: é `302` do browser, não script |
| Client secret | Não usa | Fica só no servidor (env) |
| Bloqueadores/ITP | Sensível a bloqueio de terceiros e cookies | Imune |
| Trabalho | Menor no server | ~1 rota a mais |

Vamos de Authorization Code + PKCE, redirect completo. `jose` já está instalado e traz
`createRemoteJWKSet` — a validação do `id_token` sai sem dependência nova.

### 3.2 Migração — `server/migrations/071_oauth_google.sql`

```sql
-- 071 Login com Google. Vinculamos pelo `sub` do Google (identificador estável e
-- imutável) e NUNCA só pelo e-mail: e-mail pode ser reciclado/alterado no
-- Workspace, `sub` não. O e-mail serve apenas para VINCULAR na primeira vez,
-- e mesmo assim só quando email_verified=true vem do id_token.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_sub text,
  ADD COLUMN IF NOT EXISTS avatar_url text;

CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Conta criada só pelo Google não tem senha. Login por senha precisa tratar
-- senha_hash NULL (recusar sem nem chamar scrypt, mantendo o custo de tempo).
ALTER TABLE users ALTER COLUMN senha_hash DROP NOT NULL;
```

Em `POST /api/auth/login`, com a coluna anulável:

```ts
if (!user.senha_hash) {
  await verifyAgainstDummy(senha);   // mesmo custo de tempo de uma senha errada
  return reply.code(401).send({ error: 'credenciais inválidas' });  // não revelar que a conta é Google-only
}
```

### 3.3 Rotas — `server/src/routes/oauthGoogle.ts`

```
GET  /api/auth/google/start?intent=login|register&tipo_conta=...
     → gera state (32B) + code_verifier (PKCE S256); grava ambos num cookie
       assinado httpOnly/SameSite=Lax/Secure(prod), TTL 10 min;
       302 para https://accounts.google.com/o/oauth2/v2/auth
       ?client_id=…&redirect_uri={APP_BASE_URL}/api/auth/google/callback
       &response_type=code&scope=openid%20email%20profile
       &state=…&code_challenge=…&code_challenge_method=S256&prompt=select_account

GET  /api/auth/google/callback?code=&state=
     1. state do query === state do cookie (senão 400 — CSRF)
     2. POST https://oauth2.googleapis.com/token (code, code_verifier, client_id, client_secret, redirect_uri)
     3. valida o id_token com jose:
        jwtVerify(id_token, createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
                  { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: GOOGLE_CLIENT_ID })
     4. exige payload.email_verified === true; senão 400
     5. resolve o usuário (§3.4)
     6. gera um código de troca de uso único e 302 para
        {APP_BASE_URL}/login/google?code=<uuid>      ← nada de JWT na URL

POST /api/auth/google/exchange { code }
     → troca o código de uso único (TTL 60s, uma vez só) pelo { token, user } normal
```

O `createRemoteJWKSet` cacheia as chaves com respeito ao `Cache-Control` do Google — não é uma
ida à rede por login.

O código de troca evita que o JWT apareça em `location.href`, no histórico do browser e no log
do proxy. Guardar numa tabela pequena (`oauth_exchange_codes(code_hash, user_id, expira_em,
used_at)`) ou num `Map` em memória com TTL — com uma instância só, o `Map` basta; documente que
múltiplas réplicas exigem a tabela.

### 3.4 Resolução de conta (a parte de segurança que importa)

```
sub já existe em users.google_sub?        → login direto nessa conta
senão, e-mail (verificado) existe em users?
    → VINCULAR: users.google_sub = sub. Seguro porque o Google atesta a posse do
      e-mail e o nosso registro exige e-mail confirmado (§1). Enviar e-mail de
      aviso "Google vinculado à sua conta".
senão (e-mail desconhecido)
    intent=register → criar org + usuário admin (mesma transação de /register:
        stages padrão + ensureDefaultGroups), email_verificado_em = now()
        (o Google já verificou), senha_hash = NULL
    intent=login    → 302 para /login?erro=conta_nao_encontrada (não criar conta
        silenciosamente num fluxo rotulado como "entrar")
```

Riscos e mitigação:

- **Takeover por e-mail não verificado**: mitigado no passo 4 (`email_verified === true`
  obrigatório). Sem essa checagem, quem criasse uma conta Google com o e-mail da vítima assumiria
  o tenant dela.
- **Vinculação a conta com e-mail não confirmado do nosso lado**: se `users.email_verificado_em IS
  NULL`, ainda assim vincular é seguro (o Google verificou), e aproveitar para carimbar
  `email_verificado_em`.
- **2FA e Google**: se o usuário tem 2FA confirmado, o callback **também** exige o segundo fator —
  emitir `mfa_token` e mandar para `/login/google?mfa=1`. Sem isso, o Google vira um desvio do 2FA.
- **Usuário desativado** (`ativo=false`): recusar igual ao login por senha.
- **Conta Google-only não pode "trocar senha"**: `Account.tsx` mostra "definir senha" (fluxo de
  reset por e-mail) em vez de "senha atual + nova".

### 3.5 Config e ambiente

```ts
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
  // vazio nos dois = login com Google desligado; as rotas respondem 503 e o
  // client esconde o botão (mesmo padrão da integração Evolution)
```

`GET /api/auth/providers` → `{ google: boolean }`, consumido pelo `Login.tsx` para decidir se
mostra o botão. Cookies precisam de `@fastify/cookie` (dependência nova) — ou, para evitá-la,
guardar `state`/`code_verifier` numa tabela `oauth_states` chaveada pelo `state`, sem cookie.
Prefira o cookie assinado: prende o callback ao browser que iniciou o fluxo.

No Google Cloud Console: OAuth consent screen (externo), Client ID tipo "Web application",
**Authorized redirect URIs** = `https://<domínio>/api/auth/google/callback` (produção **e**
`http://localhost:8090/...` para dev). Guardar as credenciais no `.env` da VPS (ver
`docs/DEPLOY.md`), nunca no repositório.

### 3.6 Client

- `Login.tsx`: botão "Continuar com Google" acima do formulário (separador "ou"), disparando
  `location.href = '/api/auth/google/start?intent=' + mode`. Ícone: SVG inline em `lib/icons.tsx`
  (a CSP proíbe imagem de host externo).
- Rota pública `/login/google` (`GoogleCallback.tsx`): lê `?code=`, faz o POST de exchange, seta
  o token via `setToken`, popula o contexto, navega para `/`. Erro → volta ao `/login` com
  mensagem.
- Tratar `?erro=conta_nao_encontrada` em `Login.tsx` com uma mensagem clara e um atalho para
  "Criar conta com Google".

### 3.7 Testes (`server/test/routes-auth-google.test.ts`)

O `app.inject` não segue redirect nem fala com o Google. Testar assim:

- **Unitário puro** da função de resolução de conta (`resolveGoogleUser(payload)`), que recebe o
  payload já validado do `id_token` — sem rede. Cobre: sub conhecido, vinculação por e-mail
  verificado, e-mail não verificado recusado, `intent=login` com e-mail desconhecido, usuário
  desativado, usuário com 2FA.
- **Rotas**: `/start` devolve 302 com `state` e `code_challenge` na URL; `/callback` com `state`
  divergente → 400; `/exchange` com código inválido/reusado → 400. A troca de código e a busca do
  JWKS ficam atrás de uma função injetável (`deps = { trocarCodigo, verificarIdToken }`) que os
  testes substituem — mesmo padrão do stub de Nominatim/OSRM em e2e.
- Provider desligado (env vazio) → 503 nas rotas e `providers.google === false`.

---

## 4. Ordem de implementação

| Etapa | Entrega | Depende de |
| --- | --- | --- |
| 0 | claim `typ` no JWT (§0.2) + `mailer.ts` (§0.1) | — |
| 1 | Confirmação de e-mail, política (c) só banner | 0 |
| 2 | Endurecer para a política (b) depois de medir a taxa de confirmação | 1 |
| 3 | 2FA TOTP + códigos de recuperação | 0 |
| 4 | Política `exigir_2fa` por org | 3 |
| 5 | Login com Google | 0, 1 (usa `email_verificado_em`), 3 (2FA no callback) |

Etapas 1 e 3 são independentes e podem ir em paralelo. A 5 vem por último: é a que mais depende
das outras e a única que exige configuração externa (Console do Google).

## 5. Checklist de segurança

- [ ] `typ` validado em **todo** caminho que aceita JWT (`requireAuth`, WebSocket `ws.ts`, `?token=` de mídia)
- [ ] Tokens de e-mail e códigos de troca guardados só como hash; TTL curto; uso único com `UPDATE` condicional (à prova de corrida)
- [ ] Segredo TOTP cifrado com `encryptSecret`; nunca sai da API depois do setup confirmado
- [ ] `last_step` gravado a cada validação TOTP (anti-replay)
- [ ] Códigos de recuperação com hash scrypt, uso único, regeneráveis
- [ ] Rate limit por IP **e** por usuário nos endpoints de e-mail/2FA
- [ ] `token_version` incrementado ao desativar 2FA, ao vincular/desvincular Google e no reset de senha
- [ ] E-mail de aviso em todo evento de segurança (2FA ligado/desligado, Google vinculado, código de recuperação usado)
- [ ] `email_verified === true` obrigatório no `id_token` do Google
- [ ] `state` + PKCE no OAuth, cookie httpOnly/SameSite=Lax/Secure
- [ ] JWT nunca na URL (usar o código de troca)
- [ ] Mensagens de erro do login sem distinguir "não existe" de "senha errada" de "conta Google-only"
- [ ] Auditoria (`server/src/audit.ts`) registrando ativação/desativação de 2FA e vinculação de provedor

## 6. Env novas

```bash
# SMTP de plataforma (transacional)
PLATFORM_SMTP_HOST=smtp.example.com
PLATFORM_SMTP_PORT=587
PLATFORM_SMTP_SECURE=false
PLATFORM_SMTP_USER=
PLATFORM_SMTP_PASS=
PLATFORM_FROM_EMAIL=nao-responda@rovva.com.br
PLATFORM_FROM_NAME=Rovva
APP_BASE_URL=https://app.rovva.com.br

# Confirmação de e-mail
EMAIL_VERIFICATION_REQUIRED=true
EMAIL_VERIFICATION_GRACE_DAYS=7

# Google OAuth (vazio = recurso desligado)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

## 7. Dependências novas

| Pacote | Para quê | Evitável? |
| --- | --- | --- |
| `qrcode` | QR do TOTP (SVG/dataURL no server) | Sim — mostrar só a chave base32 para digitação manual |
| `@fastify/cookie` | Cookie assinado de `state`/PKCE | Sim — tabela `oauth_states` no lugar do cookie |

TOTP, validação de `id_token` (via `jose`, já instalado) e envio de e-mail (`nodemailer`, já
instalado) não precisam de nada novo.
