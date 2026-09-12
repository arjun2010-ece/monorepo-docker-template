# syntax=docker/dockerfile:1
#
# Build from the repo root: docker build -f apps/web/Dockerfile -t jobboard/web:1.0.0 .

# ================= STAGE 1: deps =================
# Starts: fresh node:22-alpine — brings in nothing.
# Purpose: install all workspace dependencies.
# Discards: nothing — the builder stage reuses this whole /app via COPY --from=deps.
FROM node:22-alpine AS deps
WORKDIR /app

# From the build context (repo root): root lockfile + every workspace's package.json.
# No source code yet — a dependency-only layer stays cached across code changes.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/

RUN npm ci

# ================= STAGE 2: builder =================
# Starts: fresh node:22-alpine — nothing from deps exists until copied below.
# Brings in: /app from stage 'deps' (node_modules + manifests), then web source
#            and the shared package from the build context.
# Discards: after the build, everything except .next/standalone, .next/static
#           and public/ — the runner stage copies only those three.
FROM node:22-alpine AS builder
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# From stage 'deps': the prepared /app (installed node_modules + all package files).
COPY --from=deps /app ./

# From the build context: the Next.js app source code.
COPY apps/web apps/web

# From the build context: shared workspace types used by the app.
COPY packages/shared packages/shared

WORKDIR /app/apps/web
RUN npm run build

# ================= STAGE 3: runner (final image) =================
# Starts: fresh node:22-alpine — the ONLY stage that becomes the shipped image.
# Brings in: just 3 folders from stage 'builder' (standalone server, client
#            static assets, public assets).
# Discards: everything else — source code, TypeScript, full node_modules, npm.
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

USER node

# From stage 'builder': the self-contained standalone server (server.js + its
# pruned node_modules) → becomes the root of /app.
# The only place dev dependencies must be removed is the final image, and for Next.js that happens automatically via output: 'standalone'
# and below is the reason we do not need to install production dependencies separately like we do for the API.
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./

# From stage 'builder': compiled client JS/CSS — not part of the standalone output.
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static

# From stage 'builder': static assets (images, fonts, robots.txt).
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
