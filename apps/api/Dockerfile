# syntax=docker/dockerfile:1
# Production image of the API (ADR 0010). Build context: the repository root.
#   docker build -f apps/api/Dockerfile -t kb-chat-api .
# Multi-arch: linux/arm64 (OCI Ampere A1, Apple Silicon) and linux/amd64.
#
# The runtime carries three official CLIs the API spawns (ADR 0002, ADR 0007):
#   qmd    search index over MCP (primary search)
#   kb     fallback search when qmd is down (`kb search`)
#   claude Claude Code, only for the owner's subscription (KBC-007, KBC-010 BR-5)
#   codex  Codex, run only by the `codex` service, the sandbox container (KBC-027, ADR 0020)
# and ffmpeg/ffprobe for the `media-worker` service (KBC-034, ADR 0022), the same image with
# another command.
# Everything, the workspace and these global CLIs, is installed with pnpm (project rule);
# versions are pinned.

# The Node of .nvmrc: its SQLite has the FTS5 the media library's search needs.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim

# --- Build: the whole workspace, then a self-contained bundle of the API ---
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace
# Lockfile-only layer: the package store stays cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
# The runtime stage runs this same image: a Node whose SQLite lacks FTS5 stops the build here.
RUN node --no-warnings tools/check-node.mjs
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @kb-chat/contracts build && pnpm --filter @kb-chat/api build
# dist + production dependencies (including the built @kb-chat/contracts).
RUN pnpm --filter @kb-chat/api deploy --prod /out

# --- CLIs: installed under /opt/clis with the toolchain their native modules need ---
FROM ${NODE_IMAGE} AS clis
ARG QMD_VERSION=2.8.3
ARG KB_VERSION=0.0.12
ARG CLAUDE_CODE_VERSION=2.1.310
ARG CODEX_VERSION=0.164.0
# false leaves Claude Code out (an image for hosts that never use the subscription).
ARG INSTALL_CLAUDE=true
# qmd's tree-sitter grammars compile with node-gyp when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# pnpm 9 (the workspace's version) runs the CLIs' install scripts, which fetch their native
# binaries. Global packages and their shims live under /opt/clis, copied as is below.
ENV PNPM_HOME=/opt/clis/bin
ENV PATH=/opt/clis/bin:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate \
  && pnpm config set --global global-dir /opt/clis/global \
  && pnpm config set --global global-bin-dir /opt/clis/bin \
  && pnpm config set --global store-dir /tmp/pnpm-store \
  && pnpm add -g "@tobilu/qmd@${QMD_VERSION}" "@compozy/kb@${KB_VERSION}" \
  && if [ "$INSTALL_CLAUDE" = "true" ]; then \
       pnpm add -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
     fi \
  && pnpm add -g "@openai/codex@${CODEX_VERSION}" \
  && rm -rf /tmp/pnpm-store

# --- Runtime: non-root, tini as PID 1 (the CLIs run in their own process groups) ---
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=clis /opt/clis /opt/clis

# Fixed uid/gid so the host folders under /srv/kb-chat can be owned by it (cloud-init).
# `codex` (10002) runs only in the sandbox container, with /srv/kb-chat/codex (ADR 0020).
RUN groupadd --gid 10001 app \
  && useradd --uid 10001 --gid app --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
  && groupadd --gid 10002 codex \
  && useradd --uid 10002 --gid codex --no-create-home --home-dir /codex-home --shell /usr/sbin/nologin codex \
  && mkdir -p /vault /data/state /data/media /home/app/.cache/qmd /home/app/.config/qmd /home/app/.claude \
  && chown -R app:app /data /home/app

ENV NODE_ENV=production \
    PATH=/opt/clis/bin:$PATH \
    HOME=/home/app \
    HOST=0.0.0.0 \
    PORT=3000 \
    KB_VAULT=/vault \
    KB_CHAT_STATE_DIR=/data/state \
    CLAUDE_CONFIG_DIR=/home/app/.claude \
    DISABLE_AUTOUPDATER=1

WORKDIR /app
COPY --from=build --chown=app:app /out .
# The deploy files of this commit; deploy.sh copies them out on the VM (ADR 0010).
COPY deploy/compose.yml /app/deploy/compose.yml
COPY deploy/scripts /app/deploy/scripts
# The sandbox probe (ADR 0020): run on the VM by deploy/scripts/codex-vm-check.sh.
COPY deploy/codex-proof /app/deploy/codex-proof
USER app
EXPOSE 3000
# The health route answers 200 with "degraded" when qmd is down: the container stays up and
# serves search through kb; only a dead process fails this check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
