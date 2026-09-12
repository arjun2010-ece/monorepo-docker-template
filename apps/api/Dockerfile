# syntax=docker/dockerfile:1
#
# Build from the repo root: docker build -f apps/api/Dockerfile -t jobboard/api:1.0.0 .

# ================= STAGE 1: deps =================
# Starts: fresh node:22-alpine — brings in nothing.
# Purpose: install ALL dependencies (dev included — TypeScript is needed to compile).
# Discards: nothing — the builder stage reuses this whole /app via COPY --from=deps.
FROM node:22-alpine AS deps
WORKDIR /app

# From the build context (repo root): root lockfile + every workspace's package.json.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm ci

# ================= STAGE 2: builder =================
# Starts: fresh node:22-alpine — nothing from deps exists until copied below.
# Brings in: /app from stage 'deps' (full node_modules + manifests), then api
#            source and the shared package from the build context.
# Discards: after the build, everything except dist/ — the runner copies only that.
FROM node:22-alpine AS builder
WORKDIR /app

# From stage 'deps': the prepared /app (installed node_modules + all package files).
COPY --from=deps /app ./

# From the build context: the NestJS app source code.
COPY apps/api apps/api

# From the build context: shared workspace types used by the API.
COPY packages/shared packages/shared

WORKDIR /app/apps/api
RUN npm run build

# ================= STAGE 3: prod-deps =================
# Starts: fresh node:22-alpine — reuses nothing from earlier stages.
# Brings in: only manifests from the build context.
# Purpose: clean install of PRODUCTION dependencies only (--omit=dev drops the
#          Nest CLI, TypeScript and @types/*).
# Discards: nothing directly — the runner copies its node_modules.
FROM node:22-alpine AS prod-deps
WORKDIR /app

# From the build context: manifests only.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

# In Node.js, we need node_modules along with build/dist folder unlike frontend.
# This command installs only production dependencies, omitting dev dependencies.
RUN npm ci --omit=dev

# ================= STAGE 4: runner (final image) =================
# Starts: fresh node:22-alpine — the ONLY stage that becomes the shipped image.
# Brings in: production node_modules from stage 'prod-deps', compiled dist/
#            from stage 'builder'.
# Discards: everything else — source, TypeScript, dev dependencies, npm tooling.
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

USER node

# From stage 'prod-deps': the hoisted production-only node_modules tree.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# From stage 'prod-deps': the api workspace's own node_modules (workspace links).
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules

# From stage 'prod-deps': the api package.json (some libraries read it at runtime).
COPY --from=prod-deps --chown=node:node /app/apps/api/package.json ./apps/api/package.json

# From stage 'builder': the compiled JavaScript output of `nest build`.
COPY --from=builder --chown=node:node /app/apps/api/dist ./apps/api/dist

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/jobs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
