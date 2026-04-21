# syntax=docker/dockerfile:1.7
# ─── build stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# better-sqlite3 needs python + build tools to compile on slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm build

# prune devDeps for runtime
RUN pnpm prune --prod

# ─── runtime stage ───────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

# Non-root user
RUN groupadd -r strand && useradd -r -g strand strand \
  && mkdir -p /app/data && chown -R strand:strand /app

COPY --from=build --chown=strand:strand /app/node_modules ./node_modules
COPY --from=build --chown=strand:strand /app/dist ./dist
COPY --from=build --chown=strand:strand /app/prompts ./prompts
COPY --from=build --chown=strand:strand /app/config ./config
COPY --from=build --chown=strand:strand /app/src/db/schema.sql ./src/db/schema.sql
COPY --from=build --chown=strand:strand /app/package.json ./package.json

USER strand

# health: node emits `strand.boot` on stderr via pino. If process exits, Fly restarts.
CMD ["node", "--enable-source-maps", "dist/index.js"]
