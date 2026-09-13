# Job Board — Frontend (Next.js) with production Docker setup

The **frontend-only** variant of this repo: a Next.js 14 (App Router) app that server-renders job listings fetched from a separately deployed NestJS API (see the `backend-only` branch). The `main` branch contains the full monorepo; this branch strips it down to just the frontend, structured the way a standalone frontend project ships with Docker.

## Project structure

```
jobboard-web/
├── package.json              # app deps (next, react) + devDeps (typescript, @types)
├── package-lock.json         # pinned versions — makes npm ci reproducible
├── next.config.mjs           # output: 'standalone'  ← the key Docker line
├── tsconfig.json
├── next-env.d.ts
├── Dockerfile                # multistage: deps → builder → runner
├── Dockerfile-usage.md       # stage-by-stage walkthrough of the Dockerfile
├── .dockerignore             # keeps node_modules, .env, .git out of the build
├── docker-compose.yml        # runs the production image locally
├── app/
│   ├── layout.tsx
│   └── page.tsx              # server component fetching from the API
└── public/
```

## The Dockerfile in one minute

Three stages — **only the last one becomes the shipped image**:

| Stage | What it does | Ships? |
|---|---|---|
| `deps` | `npm ci` with all deps (Next.js compiler is a devDependency — the build needs it) | No |
| `builder` | `next build` with `output: 'standalone'` → emits a self-contained server | No (only 3 folders copied out) |
| `runner` | Alpine + `server.js` + pruned `node_modules` + static assets | **Yes — this IS the image** |

Why this is production-shaped, not just "working":

- **Small image (~150–200MB vs ~1.5GB single-stage)**: the runner gets only `.next/standalone` (server.js + pruned node_modules), `.next/static`, and `public/`. No source, no TypeScript, no devDependencies.
- **Fast CI**: package files are copied *before* source, so code edits reuse the cached `npm ci` layer.
- **Non-root** (`USER node`), **graceful shutdown** (exec-form `CMD` so node receives SIGTERM), **container-friendly networking** (`HOSTNAME=0.0.0.0`).
- **Runtime config via env**: `API_URL` is passed at deploy time (`-e` / compose / k8s) — one image, any environment.

Note there's no `prod-deps` stage here (unlike a NestJS backend): `output: 'standalone'` makes Next.js generate the production-only `node_modules` for you inside the build.

## Run it

```bash
npm install                 # generate package-lock.json locally (first time)
docker build -t jobboard/web:1.0.0 .
docker run -p 3000:3000 -e API_URL=http://host.docker.internal:3001 jobboard/web:1.0.0
# or simply:
docker compose up
```

Dev without Docker: `npm run dev`.

## Bug check: is the Docker config actually correct?

The quickest way to test whether the Dockerfile we wrote is right or not working is to fire the build — the build itself is the test:

```bash
docker build -t jobboard/web:1.0.0 .
```

Build success (the final lines say `naming to jobboard/web:1.0.0 ... done`) tells us that the Docker config written by us is working fine — all three stages (deps → builder → runner) completed and the image was assembled. If any instruction fails, the build stops and the error names the exact stage and line — fix that line and rebuild.

## Deployment context

CI builds the image from the repo root (`docker build -t registry.io/jobboard/web:$SHA .`), pushes it to a registry, and the same tagged image is promoted staging → prod. Kubernetes (or ECS/Fly) runs it with the env vars, scaling on traffic independently of the backend — which is exactly why the frontend and backend live as separate images.

Read `Dockerfile-usage.md` next to understand every line of the Dockerfile.
