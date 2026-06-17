FROM node:22-bookworm-slim AS deps
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY web ./web
COPY ContentPacks ./ContentPacks
WORKDIR /app/web
ENV CONTENT_ROOT=/app/ContentPacks
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app/web
ENV NODE_ENV=production
ENV PORT=3000
ENV CONTENT_ROOT=/app/ContentPacks
ENV SESSIONS_ROOT=/tmp/opscoach-sessions
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-client python3 ca-certificates curl \
  && curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /app/rds-global-bundle.pem \
  && rm -rf /var/lib/apt/lists/*
ENV DATABASE_CA_PATH=/app/rds-global-bundle.pem
# Custom server (server.js) bridges a WebSocket terminal to the lab over SSH, so we ship
# the full build + node_modules and run node directly (not the standalone server).
COPY --from=builder /app/web/.next ./.next
COPY --from=builder /app/web/node_modules ./node_modules
COPY --from=builder /app/web/package.json ./package.json
COPY --from=builder /app/web/next.config.ts ./next.config.ts
COPY --from=builder /app/web/server.js ./server.js
COPY ContentPacks /app/ContentPacks
# Run as the built-in non-root node user.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
