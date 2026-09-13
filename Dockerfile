# syntax=docker/dockerfile:1
#
# Build: docker build -t jobboard/api:1.0.0 .

# ================= STAGE 1: deps =================
# Starts: fresh node:22-alpine — brings in nothing.
# Purpose: install ALL dependencies (dev included — TypeScript and the Nest
#          CLI are devDependencies, and this stage needs them to compile).
# Discards: nothing — the builder stage reuses this node_modules via COPY --from=deps.
FROM node:22-alpine AS deps
WORKDIR /app

# From the build context: package.json + lockfile. No source yet — a
# dependency-only layer stays cached across code changes.
COPY package.json package-lock.json ./

RUN npm ci

# ================= STAGE 2: builder =================
# Starts: fresh node:22-alpine — nothing from deps exists until copied below.
# Brings in: node_modules from stage 'deps', then the app source from the
#            build context.
# Discards: after the build, everything except dist/ — the runner copies only that.
FROM node:22-alpine AS builder
WORKDIR /app

# From stage 'deps': the installed node_modules.
COPY --from=deps /app/node_modules ./node_modules

# From the build context: the NestJS app source code.
COPY . .

# Compiles TypeScript → plain JavaScript into dist/. Nothing at runtime needs
# TypeScript or the Nest CLI after this.
RUN npm run build

# ================= STAGE 3: prod-deps =================
# Starts: fresh node:22-alpine — reuses nothing from earlier stages.
# Brings in: only the manifests from the build context.
# Purpose: clean install of PRODUCTION dependencies only (--omit=dev drops the
#          Nest CLI, TypeScript and @types/*). Unlike Next.js's standalone
#          output, tsc emits no trimmed node_modules — so we build one by hand.
# Discards: nothing directly — the runner copies its node_modules.
FROM node:22-alpine AS prod-deps
WORKDIR /app

# From the build context: manifests only.
COPY package.json package-lock.json ./

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

# From stage 'prod-deps': the production-only node_modules tree.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# From stage 'prod-deps': package.json (some libraries read it for version metadata).
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json

# From stage 'builder': the compiled JavaScript output of `nest build`.
COPY --from=builder --chown=node:node /app/dist ./dist

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/jobs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
