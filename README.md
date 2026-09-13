# Production Multistage Docker Builds — Next.js + NestJS Monorepo

A practical guide written for a frontend developer moving to fullstack. Read this top-to-bottom once, then keep the Dockerfiles open as reference — every non-obvious line in them is explained here.

---

## 1. The example app

**Job Board** — a Next.js 14 (App Router) frontend that server-renders job listings fetched from a NestJS REST API, with shared TypeScript types in a `packages/shared` workspace. Classic mid-level fullstack monorepo: one repo, two deployable services.

## 2. Folder structure

```
jobboard/
├── package.json               # npm workspaces root — defines apps/* and packages/*
├── package-lock.json          # ONE lockfile for the whole monorepo (pinned versions)
├── .dockerignore              # filters what `docker build` sends to the daemon
├── docker-compose.yml         # runs both images locally; k8s/ECS replaces this in prod
│
├── apps/
│   ├── web/                   # ── Next.js frontend (deployable unit #1) ──
│   │   ├── Dockerfile         #   multistage: deps → builder → runner
│   │   ├── package.json
│   │   ├── next.config.mjs    #   output: 'standalone'  ← the key Docker line
│   │   └── app/
│   │       ├── layout.tsx
│   │       └── page.tsx       #   server component fetching from the API
│   │
│   └── api/                   # ── NestJS backend (deployable unit #2) ──
│       ├── Dockerfile         #   multistage: deps → builder → prod-deps → runner
│       ├── package.json       #   devDeps (nest CLI, TS) vs deps (runtime)
│       ├── nest-cli.json
│       ├── tsconfig.json
│       └── src/
│           ├── main.ts        #   bootstrap: listens on 0.0.0.0:$PORT
│           └── app.module.ts  #   JobsController (GET/POST /jobs)
│
└── packages/
    └── shared/                # shared TS types imported by BOTH apps
        ├── package.json
        └── index.ts           # Job, CreateJobDto
```

Why this shape:

- **`apps/` = things you deploy, `packages/` = things you import.** Each app gets its own image, its own CI pipeline, its own release cadence. The API can deploy 5× a day without touching the frontend.
- **One root lockfile** is what makes Docker caching work cleanly — the `deps` stage copies the lockfile + every workspace's `package.json`, runs `npm ci` once, and gets the entire hoisted dependency tree.

---

## 3. Why multistage builds exist

A single-stage Dockerfile looks like this:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
CMD ["node", "dist/main.js"]
```

It "works", and it's exactly what you'd write on day one. It ships to production:

- **All devDependencies** — TypeScript, Nest CLI, webpack, eslint, test runners. Hundreds of MB of tooling the running app never touches.
- **Your source code** — business logic is fine to ship, but tests, configs, docs, and any stray `.env` copied with `COPY . .` go too.
- **Attack surface** — every binary in the image is something a CVE or a compromised dependency can use. Fewer tools in the image = smaller blast radius.
- **Slow pushes/pulls** — registries charge for storage, CI uploads every release, and Kubernetes must pull the image onto every node it schedules on. Image size is directly on your deploys' critical path.

**A multistage build solves this with one idea:** a Dockerfile can have multiple `FROM` stages, each starting fresh, and a later stage can copy *files* from an earlier stage via `COPY --from=`. Stages are disposable workbenches; the **final stage is the only thing that becomes the image**. Everything else — dev deps, source, compiler — is garbage collected unless the final stage explicitly copies it.

Mental model: *compile in a fully-equipped workshop, ship only the finished furniture.*

## 4. Anatomy of the stages

### Stage roles (NestJS example; Next.js is the same minus one stage)

| Stage | Purpose | Ends up in the image? |
|---|---|---|
| `deps` | `npm ci` with **all** deps (dev included — you need TS to compile) | No |
| `builder` | Compile TypeScript → `dist/` plain JS | No (only `dist/` is copied out) |
| `prod-deps` | Second, clean `npm ci --omit=dev` | No (only its `node_modules` is copied out) |
| `runner` | Alpine base + `dist/` + prod `node_modules` | **Yes — this IS the image** |

### The layer-caching trick (the single most important pattern)

```dockerfile
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN npm ci
COPY apps/web apps/web          # ← source comes AFTER install
```

Docker caches each instruction as a layer and reuses it if its inputs didn't change. `npm ci`'s inputs are the package files — so **on a normal code change, CI skips the 2-minute install entirely** and reruns only the build. If you wrote `COPY . .` first, every single file edit would invalidate the cache and re-run the install. This ordering alone cuts typical CI build times from ~5 minutes to ~1.

### `npm ci` vs `npm install`

In any Dockerfile used by CI/production, always `npm ci`:

1. installs **exactly** the versions pinned in `package-lock.json` → the image you build today matches the one you built last month;
2. starts by deleting `node_modules` → no stale state;
3. hard-fails if `package.json` and lockfile disagree → catches drift at build time instead of at 3am in prod.

### Why a separate `prod-deps` stage instead of `npm prune --omit=dev`?

`npm prune` walks the full tree and removes dev packages — slow, historically buggy, and it still requires the dev tree to have existed. A clean `npm ci --omit=dev` in a fresh stage is faster (parallel with the build stage), cacheable, and *guarantees* the dependency tree is minimal by construction rather than by subtraction.

> Note for the web app: it doesn't need this stage because `next build` with `output: 'standalone'` **itself** produces the pruned `node_modules` (see §5). NestJS compiles to plain JS with no such helper, so it needs the explicit `prod-deps` stage. Same pattern, different mechanism — understand the *goal* (smallest possible runtime dependency set), not just the incantation.

## 5. Framework specifics

### Next.js: `output: 'standalone'`

```js
// next.config.mjs
const nextConfig = { output: 'standalone' };
```

`next build` normally produces `.next/` artifacts that still require the full `node_modules` and the `next` CLI to serve. With `standalone`, the build additionally emits `.next/standalone/` — a **self-contained server**: a minimal `server.js` plus a `node_modules` trimmed to *only* the packages the server actually imports at runtime (often 90% smaller). The runner image then copies exactly three things:

```dockerfile
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/apps/web/public ./apps/web/public
```

- `.next/static` and `public/` are **not** included in standalone — they're immutable client assets, so you copy them next to the server. (The path structure matters: standalone preserves the monorepo layout `apps/web/server.js`.)
- In a real company you'd often serve `.next/static` and `public/` from a **CDN** instead, and the container only handles SSR/API routes.

### NestJS: compile and prune

`nest build` runs `tsc` → `apps/api/dist/*.js`. The runtime needs three things and nothing else: `dist/`, production `node_modules`, and `package.json` (some libraries read it for version info). TypeScript, decorators-config, Nest CLI, `@types/*` — all devDependencies, all excluded by `--omit=dev`.

### FAQ: why doesn't the `deps` stage remove devDependencies?

Because devDependencies are exactly what the build stages need — and since `deps`/`builder` never ship, there is no reason to slim them down. The only place dev dependencies must be removed is the **final image**.

Three things make this click:

1. **The `deps` stage is disposable scaffolding.** Its contents live only in intermediate build layers. The `runner` stage copies just the standalone output, `.next/static`, and `public/` (web) or `dist/` + prod `node_modules` (api) — the full `node_modules` is never copied into the final image. A "bloated" deps stage costs build time, not image size.
2. **Removing dev deps at stage 1 would break the build.** `next build` needs the Next.js compiler and TypeScript — both devDependencies. `npm ci --omit=dev` in `deps` would make stage 2 fail with `sh: next: command not found`. Rule: *dev deps are wanted in build stages, unwanted in the final image — remove them where it counts, not everywhere.*
3. **For Next.js, the pruning is done by `output: 'standalone'`** — Next traces the server's runtime imports and emits `.next/standalone/` with its own production-only `node_modules`. That trimmed tree is what enters the runner image.

The NestJS Dockerfile needs the explicit `prod-deps` stage precisely because it has no equivalent of `standalone`: `tsc` just emits `dist/`, and the compiled code still does `require('@nestjs/core')` at runtime, so a real production-only `node_modules` must be built by hand.

| | web (Next.js) | api (NestJS) |
|---|---|---|
| Where dev deps are installed | `deps` stage, all workspaces | `deps` stage, all workspaces |
| Why dev deps are needed | `next build` runs the compiler/TS | `tsc` compiles TypeScript |
| Who prunes them | `output: 'standalone'` (Next.js does it) | explicit `prod-deps` stage: `npm ci --omit=dev` |
| Dev deps in final image | none — standalone's pruned tree only | none — prod-deps tree only |

Worth 30 seconds once you build the images: `docker run --rm jobboard/web:1.0.0 ls node_modules` — you'll find only a handful of runtime packages, with no `typescript` or `eslint`. That's the proof pruning happened, even though stage 1 installed everything.

## 6. Production hardening (what separates tutorial Dockerfiles from company ones)

**Non-root user.** Container escapes are a real threat class; if your app is compromised, `USER node` means the attacker is an unprivileged user (uid 1000, shipped with the official Node images) instead of root inside the container. Two lines, non-negotiable.

**Exec-form `CMD`.**
```dockerfile
CMD ["node", "apps/web/server.js"]        # ✅ exec form: node IS PID 1
CMD node apps/web/server.js               # ❌ shell form: /bin/sh is PID 1
```
`docker stop` / Kubernetes send `SIGTERM` to PID 1. In shell form, the signal hits `sh`, which ignores it — after the 10–30s grace period, the process is `SIGKILL`ed, dropping in-flight requests on every deploy. Exec form makes node itself PID 1 so it can shut down gracefully. (Even better: use `tini -- node ...` or Node ≥20.12 which handles SIGTERM natively as PID 1.)

**Listen on `0.0.0.0`.** Inside a container, `localhost` is the container's own loopback — nothing outside can reach it. Servers must bind `0.0.0.0` and take the port from `process.env.PORT` (orchestrators assign it). This is the most common reason a containerized app "works locally, unreachable in prod".

**Build-time vs runtime configuration (ARG vs ENV).**
- `ARG` — exists only during `docker build` (e.g. `NEXT_PUBLIC_APP_VERSION`, since Next bakes `NEXT_PUBLIC_*` into client bundles at build time).
- Runtime env (`API_URL`, `PORT`, DB URLs, secrets) — passed at `docker run -e` / k8s `env:`. **One image per version, environment supplied at deploy time.** If config were baked in, you'd need a different image for staging and prod — which breaks the golden rule: *the exact artifact you tested in staging is what ships to prod.*
- Secrets are never ARGs/ENVs in the Dockerfile — they persist in image layers and `docker history`. Use a secret manager (k8s Secrets, Vault, SSM).

**`HEALTHCHECK`.** Tells Docker whether the app is actually serving (ECS and compose use it; Kubernetes ignores it in favor of its own liveness/readiness probes). Note the trick in the API Dockerfile: use `node -e` instead of `curl`, because alpine images don't ship curl — that's a classic build failure.

**BuildKit cache mounts (optional).** You'll see this in fancier company Dockerfiles:
```dockerfile
RUN --mount=type=cache,target=/root/.npm npm ci
```
Keeps npm's download cache *outside* the image layers — shared across builds on the same machine, adds zero bytes to the image. It's a pure CI speedup, not a correctness or security feature, so the example Dockerfiles in this repo leave it out to stay lean.

**Alpine vs distroless.** `node:22-alpine` (~180MB with the app) is the pragmatic default: small, has a shell for debugging. `node:22-slim` if you hit alpine's musl libc quirks. **Distroless** (`gcr.io/distroless/nodejs22`) is the most hardened — no shell, no package manager, just node + your app — used in high-security shops, at the cost of "can't exec in to debug". Start with alpine; know distroless exists.

**`.dockerignore`.** `docker build` uploads the entire build context to the daemon. Without `.dockerignore` that includes host `node_modules` (gigabytes, wrong platform), `.git`, and — dangerously — `.env` files that a `COPY . .` would permanently bake into a layer (deleting the file later doesn't help; it's in layer history). Treat `.dockerignore` as a security control, not an optimization.

## 7. Deployment context — how this fits a company pipeline

```
git push → CI (GitHub Actions / GitLab CI)
             ├─ lint, typecheck, unit tests            (plain node, no Docker)
             ├─ docker build -f apps/api/Dockerfile -t registry.io/jobboard/api:$SHA .
             ├─ docker build -f apps/web/Dockerfile -t registry.io/jobboard/web:$SHA .
             ├─ (optional) image scan: trivy / docker scout
             ├─ docker push  → container registry (ECR / GAR / GHCR / Docker Hub)
             └─ deploy: staging env gets $SHA → smoke tests → promote SAME tag to prod
```

Key points:

- **Build from the repo root.** `docker build -f apps/api/Dockerfile .` — the `.` is the *build context* (what Docker can `COPY` from). Since a monorepo Dockerfile needs `packages/shared/` and the root lockfile, the context must be the repo root, not the app folder. The `-f` flag just points at the Dockerfile inside it.
- **Immutable, tagged images.** Tag by git SHA (`jobboard/api:a1b2c3d`) plus semver; `latest` is for local only — prod deployments pin explicit versions so a rollback is "repoint to the previous tag".
- **Where it runs.** Kubernetes (most common at scale): your image's `HEALTHCHECK`-equivalent becomes liveness/readiness probes; `PORT`/env come from manifests; the API is an internal ClusterIP service, the web is exposed via ingress/CDN. Smaller shops use ECS/Fargate or Fly.io/Railway — same images, different runtime config. `docker-compose.yml` here is only for local dev parity.
- **Scaling.** The API scales independently of the web (that's *why* two images): API scales on CPU/request rate, web scales on traffic; each gets its own resource limits, rollout strategy, and restart policy.

## 8. Common mistakes (each one is a real production incident story)

1. **`COPY . .` without `.dockerignore`** → host `node_modules` (macOS binaries) breaks the Linux image; `.env` gets baked in permanently.
2. **Installing deps after copying source** → cache invalidated on every commit; CI feels 5× slower and everyone blames "Docker being slow".
3. **`npm install` instead of `npm ci`** → non-reproducible builds; a transitive dep releases a breaking patch and prod builds diverge from the one you tested.
4. **Shell-form CMD** → SIGTERM never reaches node → 10s SIGKILL on every deploy → dropped requests.
5. **App binds `localhost`** → works locally, connection refused in the cluster.
6. **Secrets via `ENV`/`ARG` in the Dockerfile** → `docker history` shows your DB password to anyone who can pull the image.
7. **One combined frontend+backend image** → you redeploy React button styling and restart your API at the same time; you can't scale them independently.
8. **Forgetting `--omit=dev`** → 1.5GB images that take 3 minutes to pull on pod startup, and compilers available to any attacker who gets code execution.
9. **Wrong build context** (running `docker build .` from `apps/api/`) → `COPY packages/shared ...` fails with "not found".

## 9. Try it

```bash
cd nextjs-nestjs-docker

# generate the lockfile (needed by npm ci inside the build)
npm install

# build both images from the repo root
docker build -f apps/api/Dockerfile -t jobboard/api:1.0.0 .
docker build -f apps/web/Dockerfile -t jobboard/web:1.0.0 .

# compare sizes — this is the whole point of multistage
docker images | grep jobboard

# run them
docker compose up

# open http://localhost:3000

# inspect what actually shipped: no npm, no src, no devDeps
docker run --rm jobboard/api:1.0.0 ls /app
```

Then experiment: delete a source file and rebuild (watch the `deps` layer stay `CACHED`), change `package.json` and rebuild (watch it re-run), and run `docker history jobboard/api:1.0.0` to see how layers stack.

## 10. Bug check: is the Docker config actually correct?

The quickest way to test whether the Dockerfiles we wrote are right or not working is to fire the build — the build itself is the test:

```bash
docker build -f apps/web/Dockerfile -t jobboard/web:1.0.0 .
docker build -f apps/api/Dockerfile -t jobboard/api:1.0.0 .
```

Build success (the final lines say `naming to ... done`) tells us that the Docker config written by us is working fine — every stage (deps → builder → prod-deps → runner) completed and the image was assembled. If any instruction fails, the build stops and the error names the exact stage and line, e.g. `RUN npm ci` exited with code 1 — fix that line and rebuild.
