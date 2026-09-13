# `Dockerfile` — Stage-by-Stage Walkthrough (backend)

A beginner-friendly explanation of the NestJS production Dockerfile in this repo. Read this alongside the file itself — every instruction in it is covered here.

## The big picture

A multistage Dockerfile is **several completely separate mini-images written in one file**. Each `FROM` line starts a new, empty image — nothing carries over automatically. A later stage can reach back and grab *files* from an earlier stage with `COPY --from=<stage-name>`, but only explicit file copies.

The purpose: the first three stages are messy workshops full of heavy tools (npm, TypeScript, the Nest CLI, all dependencies). Only the final stage becomes the actual image that ships to production — and it only contains what we explicitly copied into it. **Compile in a fully-equipped workshop, ship only the finished furniture.**

Think of it as a pipeline your code flows through:

```
deps      →  installs all node_modules       (thrown away afterwards)
builder   →  compiles TS → dist/             (thrown away afterwards)
prod-deps →  installs prod-only node_modules (thrown away afterwards)
runner    →  receives dist/ + prod node_modules  (THIS becomes your image)
```

**Why 4 stages when the frontend needs 3?** The frontend's Next.js `output: 'standalone'` generates the production-only `node_modules` automatically during the build. NestJS's `tsc` does not — `dist/main.js` still does `require('@nestjs/core')` at runtime, so someone must manufacture a clean production-only dependency tree. That's the `prod-deps` stage's job.

---

## The header

```dockerfile
# syntax=docker/dockerfile:1
```
Tells Docker to use the modern BuildKit parser for Dockerfile syntax. The build is a plain single-app build now (no monorepo `-f` flag or root-context gymnastics):

```bash
docker build -t jobboard/api:1.0.0 .
```

---

## Stage 1 — `deps`: install everything

```dockerfile
FROM node:22-alpine AS deps
```
`FROM` means "start from this base image". `node:22-alpine` is the official Node.js 22 image built on **Alpine Linux** — a deliberately tiny Linux distribution (~50MB vs ~1GB for the full one). `AS deps` names the stage so later stages can refer to it.

```dockerfile
WORKDIR /app
```
Creates `/app` and moves into it — every relative path after this is relative to `/app`.

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci
```
Only the manifests are copied — **no source code yet**. `npm ci` installs exactly the versions locked in `package-lock.json` (unlike `npm install`, which can drift). DevDependencies *are* included on purpose: TypeScript and the Nest CLI are devDependencies, and the build cannot run without them.

### Why copy package files *before* source? (the caching trick)

Docker caches every instruction as a **layer** and reuses it if its inputs didn't change. `npm ci`'s inputs are the two package files — so editing a controller doesn't invalidate the install layer. CI re-runs only the compile. Writing `COPY . .` first would invalidate the cache on *every* commit and re-install every time — the #1 "Docker is slow" mistake.

---

## Stage 2 — `builder`: compile TypeScript to JavaScript

```dockerfile
FROM node:22-alpine AS builder
```
A brand-new, empty image. Nothing from `deps` exists until copied:

```dockerfile
COPY --from=deps /app/node_modules ./node_modules
COPY . .
```
First the installed dependencies (via `--from=deps` — "copy from the stage named `deps`"), then the actual source code from the build context. Thanks to `.dockerignore`, `COPY . .` does **not** bring in your local `node_modules`, `.env` files, or `.git`.

```dockerfile
RUN npm run build
```
Runs `nest build`, which is `tsc` under the hood: `src/*.ts` → `dist/*.js` plain JavaScript. After this line, **nothing at runtime needs TypeScript, decorators config, or the Nest CLI** — that's the whole point of separating build from run. Everything heavy in this stage is throwaway.

---

## Stage 3 — `prod-deps`: the stage the frontend doesn't need

```dockerfile
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
```
A **fresh install with only production dependencies**. Why a separate stage instead of trimming the `deps` stage?

- You *can't* just prune stage 1 — `builder` needs the dev deps for compiling.
- You *could* run `npm prune --omit=dev` inside the builder after building — but pruning a dev-laden tree is slow and less deterministic than a clean install.
- A dedicated stage is **cacheable independently** (depends only on the package files) and runs **in parallel with the builder** in CI, since neither depends on the other.

`--omit=dev` excludes TypeScript, `@nestjs/cli`, `@types/*` — nothing the compiled app requires at runtime.

---

## Stage 4 — `runner`: the image that actually ships

```dockerfile
FROM node:22-alpine AS runner
WORKDIR /app
```
Another fresh, empty image. **This is the final stage — the only one that becomes the published image.**

```dockerfile
ENV NODE_ENV=production \
    PORT=3001
```
`NODE_ENV=production` makes libraries take leaner code paths; `PORT` is read by `main.ts` so you can override it at runtime (`docker run -e PORT=8080`).

```dockerfile
USER node
```
Everything runs as the unprivileged `node` user (uid 1000, shipped with the official image) instead of root. If a vulnerability is exploited, the attacker lands as a low-privilege user rather than owning the container.

```dockerfile
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/dist ./dist
```
The payoff — only three things enter the final image:

1. **prod `node_modules`** — from the `prod-deps` stage. This is what `dist/main.js`'s `require('@nestjs/core')` resolves against.
2. **`package.json`** — some libraries read it for version metadata.
3. **`dist/`** — the compiled application, from the `builder` stage.

`--chown=node:node` makes the files owned by the `node` user instead of root.

What's *not* here: no `src/`, no `tsconfig`, no TypeScript, no Nest CLI, no dev dependencies. That's how this image lands around 150–200MB while a single-stage build of the same API is easily 1.5GB.

```dockerfile
EXPOSE 3001
```
Purely documentation. It does **not** publish the port — that's `docker run -p 3001:3001` or the `ports:` section in compose/Kubernetes.

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/jobs').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```
Tells Docker whether the app is actually serving (used by compose/ECS; Kubernetes ignores it in favor of its own liveness/readiness probes). Note `node -e` instead of `curl` — alpine ships no curl, a classic build failure.

```dockerfile
CMD ["node", "dist/main.js"]
```
The command the container runs when it starts:

- **What it runs**: the compiled bootstrap directly — no nest CLI involved.
- **Why the JSON-array "exec form" matters**: in exec form, `node` itself becomes PID 1 (the container's main process). When `docker stop` or Kubernetes terminates the pod, `SIGTERM` reaches node directly and it can finish in-flight requests before exiting. In shell form (`CMD node dist/main.js`), *sh* becomes PID 1, ignores `SIGTERM`, and your process is force-killed after the grace period — dropping in-flight requests on every deploy.

---

## One-file trace, start to finish

Follow your own code through the pipeline to cement it:

1. Your controller (`src/app.module.ts`) enters at **stage 2** via `COPY . .`.
2. `nest build` compiles it to plain JS inside `dist/`.
3. **Stage 4** receives exactly `dist/` + production `node_modules` + `package.json` — and nothing else ever existed as far as the final image is concerned.

---

## FAQ: why doesn't the `deps` stage remove devDependencies?

Because devDependencies are exactly what the build stages need — and since `deps`/`builder`/`prod-deps` never ship, there is no reason to slim them down. The only place dev dependencies must be removed is the **final image**. Running `npm ci --omit=dev` in stage 1 would break stage 2 with `sh: nest: command not found`. The full `node_modules` never reaches the runner stage — which is the only place it would matter.
