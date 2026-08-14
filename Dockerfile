# Multi-stage: build the React client, then run the Fastify server that serves
# both the API and the built static assets in a single Node process.

# ---- stage 1: build client ----
FROM node:24-alpine AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- stage 2: runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Chromium renderiza SPAs durante fallback da busca de contatos.
RUN apk add --no-cache chromium
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
# only production deps; the server runs TypeScript directly via Node 24 type-stripping
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=client /client/dist ./client/dist
ENV CLIENT_DIR=/app/client/dist
ENV PORT=8080
EXPOSE 8080
# migrations run idempotently on boot, then the server starts
CMD ["sh", "-c", "node scripts/migrate.ts && node src/index.ts"]
