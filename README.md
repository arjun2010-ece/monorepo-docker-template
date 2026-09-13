# Job Board — Backend (NestJS) with production Docker setup

The **backend-only** variant of this repo: a NestJS REST API serving job listings, consumed by a separately deployed Next.js frontend (see the `frontend-only` branch). The `main` branch contains the full monorepo; this branch strips it down to just the API, structured the way a standalone backend project ships with Docker.

## Project structure

```
jobboard-api/
├── package.json              # runtime deps (@nestjs/*) + devDeps (nest CLI, typescript)
├── package-lock.json         # pinned versions — makes npm ci reproducible
├── nest-cli.json
├── tsconfig.json
├── Dockerfile                # multistage: deps → builder → prod-deps → runner
├── Dockerfile-usage.md       # stage-by-stage walkthrough of the Dockerfile
├── .dockerignore             # keeps node_modules, .env, .git out of the build
├── docker-compose.yml        # runs the production image locally
└── src/
    ├── main.ts               # bootstrap: listens on 0.0.0.0:$PORT
    └── app.module.ts         # JobsController (GET/POST /jobs)
```

## The Dockerfile in one minute

Four stages — **only the last one becomes the shipped image**:

| Stage | What it does | Ships? |
|---|---|---|
| `deps` | `npm ci` with **all** deps (TypeScript + Nest CLI are devDependencies — needed to compile) | No |
| `builder` | `nest build` → compiles TypeScript to plain JS in `dist/` | No (only `dist/` copied out) |
| `prod-deps` | Clean `npm ci --omit=dev` → production-only `node_modules` | No (only its `node_modules` copied out) |
| `runner` | Alpine + `dist/` + prod `node_modules` | **Yes — this IS the image** |

**Why 4 stages when the frontend needs 3?** One job differs: the frontend's Next.js `output: 'standalone'` automatically generates a production-only `node_modules` during the build. A NestJS build (`tsc`) emits only `dist/` — the compiled code still does `require('@nestjs/core')` at runtime, so a production-only `node_modules` must be manufactured explicitly. The `prod-deps` stage is that job, kept separate because it's cacheable independently and runs in parallel with the build in CI.

Why this is production-shaped, not just "working":

- **Small image (~150–200MB vs ~1.5GB single-stage)**: no TypeScript, no Nest CLI, no devDependencies, no source.
- **Fast CI**: package files copied before source keeps the `npm ci` layers cached.
- **Non-root** (`USER node`), **graceful shutdown** (exec-form `CMD` so node receives SIGTERM), **container-friendly networking** (`listen(port, '0.0.0.0')` in `main.ts`).
- **Health check**: `HEALTHCHECK` polls `/jobs` with `node -e` (alpine ships no curl) — used by Docker/compose/ECS; Kubernetes maps the idea to its own readiness probes.
- **Runtime config via env**: `PORT`, `CORS_ORIGIN`, DB URLs etc. passed at deploy time — one image, any environment. Secrets never live in the Dockerfile.

## Run it

```bash
npm install                 # generate package-lock.json locally (first time)
docker build -t jobboard/api:1.0.0 .
docker run -p 3001:3001 -e CORS_ORIGIN=http://localhost:3000 jobboard/api:1.0.0
# or simply:
docker compose up
curl http://localhost:3001/jobs
```

Dev without Docker: `npm run start:dev`.

## Deployment context

CI builds the image (`docker build -t registry.io/jobboard/api:$SHA .`), pushes it to a registry, and the same tagged image is promoted staging → prod. In Kubernetes the API runs as an internal service (not internet-facing), scales on CPU/request rate independently of the frontend, and gets its DB credentials from a secret manager — never from the image.

Read `Dockerfile-usage.md` next to understand every line of the Dockerfile.
