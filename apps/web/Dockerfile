# syntax=docker/dockerfile:1
# Production image of the web edge (ADR 0010): Caddy serving the built SPA, with the
# Caddyfile and the generated Content-Security-Policy baked in, so a rollback to a previous
# image tag also rolls back the edge configuration. Build context: the repository root.
#   docker build -f apps/web/Dockerfile -t kb-chat-web .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG CADDY_IMAGE=caddy:2.10-alpine

# --- Build: the SPA and its CSP snippet ---
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @kb-chat/contracts build && pnpm --filter @kb-chat/web build
RUN node deploy/web/csp.mjs apps/web/dist/browser/index.html > /workspace/csp.caddy

# --- Runtime: Caddy (runs as root to bind 80/443 inside the container only) ---
FROM ${CADDY_IMAGE} AS runtime
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/csp.caddy /etc/caddy/csp.caddy
COPY --from=build /workspace/apps/web/dist/browser /srv/www
# The real domain comes from the environment at run time; validate with a stand-in.
RUN KB_CHAT_DOMAIN=localhost caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
EXPOSE 80 443 443/udp
