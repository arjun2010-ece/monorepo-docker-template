# `Dockerfile` — Stage-by-Stage Walkthrough (frontend)

A beginner-friendly explanation of the Next.js production Dockerfile in this repo. Read this alongside the file itself — every instruction in it is covered here.

## The big picture

A multistage Dockerfile is **three completely separate mini-images written in one file**. Each `FROM` line starts a new, empty image — nothing carries over automatically. A later stage can reach back and grab *files* from an earlier stage with `COPY --from=<stage-name>`, but only explicit file copies.

The purpose: stages 1 and 2 are messy workshops full of heavy tools (npm, TypeScript, the Next.js compiler, all dependencies). Only stage 3 becomes the actual image that ships to production — and it only contains what we explicitly copied into it. **Compile in a fully-equipped workshop, ship only the finished furniture.**

Think of it as a pipeline your code flows through:

```
deps    →  installs node_modules          (thrown away afterwards)
builder →  uses those + source to build   (thrown away afterwards)
runner  →  receives only 3 folders        (THIS becomes your image)
```

---

## The header

```dockerfile
# syntax=docker/dockerfile:1
```
Tells Docker to use the modern BuildKit parser for Dockerfile syntax. You almost always want this line; it just guarantees newer syntax works.

The build is now dead simple compared to the monorepo — no `-f` flag needed because the Dockerfile is at the root, and the build context is simply the project folder:

```bash
docker build -t jobboard/web:1.0.0 .
```

---

## Stage 1 — `deps`: install dependencies

```dockerfile
FROM node:22-alpine AS deps
```
`FROM` means "start from this base image". `node:22-alpine` is the official Node.js 22 image built on **Alpine Linux** — a deliberately tiny Linux distribution (~50MB vs ~1GB for the full one). `AS deps` names this stage so later stages can refer to it by name.

```dockerfile
WORKDIR /app
```
Creates `/app` and moves into it. Every relative path after this line is relative to `/app`. It's the Docker equivalent of `mkdir + cd`.

```dockerfile
COPY package.json package-lock.json ./
```
We copy **only the files that describe dependencies** — no source code yet. In a single-app repo that's just the two manifest files (the monorepo version needed every workspace's `package.json` too; that's gone now).

```dockerfile
RUN npm ci
```
Installs everything the lockfile pins. Key points:

- **`npm ci` vs `npm install`**: `ci` installs *exactly* the versions locked in `package-lock.json`, wipes any existing `node_modules` first, and fails if the lockfile disagrees with the `package.json`. That gives reproducible builds — the image you build today matches last month's. Rule: `npm ci` inside Docker, always.
- **Why devDependencies are included**: the Next.js compiler and TypeScript are devDependencies, and stage 2 needs them to build. They get dropped later.

### Why copy package files *before* source? (the caching trick)

Docker caches the result of every instruction as a **layer**, and reuses a cached layer only if its inputs haven't changed. `npm ci`'s inputs are the package files — so:

- You edit a React component → package files unchanged → the `npm ci` layer is reused instantly → only the build re-runs. CI takes ~1 minute.
- If instead you wrote `COPY . .` first, *every* code edit would change the context and force a full re-install on every build.

This ordering is the single biggest speed lever in the whole file. (Note: `COPY . .` in stage 2 is fine precisely because stage 1 already isolated the dependency install.)

---

## Stage 2 — `builder`: compile the app

```dockerfile
FROM node:22-alpine AS builder
```
A brand-new, empty image. Nothing from `deps` exists here — until we copy it in:

```dockerfile
COPY --from=deps /app/node_modules ./node_modules
```
`--from=deps` means "copy from the stage named `deps` instead of from the build context". This brings over the installed dependencies.

```dockerfile
COPY . .
```
Now the actual source code, copied from the build context (the whole project folder). Thanks to `.dockerignore`, this does **not** bring in your local `node_modules`, `.next`, `.env` files, or `.git` — those would either break the Linux build or leak secrets into a layer permanently.

```dockerfile
RUN npm run build
```
Runs `next build`. Because `next.config.mjs` contains `output: 'standalone'`, this produces an extra artifact: `.next/standalone/`.

**What standalone actually is:** normally, running a built Next.js app still requires the full `node_modules` and the `next` CLI. With `standalone`, Next traces every import your server actually uses at runtime and emits a **self-contained folder**: a minimal `server.js` plus a tiny `node_modules` containing only what that server needs (often 90% smaller than the full one). It's Next.js doing the "prune dependencies for production" work for you — which is why this Dockerfile needs no separate `prod-deps` stage, unlike a NestJS backend.

Everything else in this stage — TypeScript, webpack caches, the full `node_modules`, your source — will simply be thrown away.

---

## Stage 3 — `runner`: the image that actually ships

```dockerfile
FROM node:22-alpine AS runner
WORKDIR /app
```
Another fresh, empty image. **This is the final stage — the only one that becomes the published image.** The previous two exist purely as construction scaffolding.

```dockerfile
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
```
Environment variables baked into the image (the `\` is just line continuation). Why these matter:

- `NODE_ENV=production` — many libraries take faster/leaner code paths and skip dev-only warnings.
- `PORT=3000` — the standalone server reads this to decide which port to listen on. It's an env var (not hardcoded) so you can override it at runtime: `docker run -e PORT=8080`.
- `HOSTNAME=0.0.0.0` — subtle but critical. Inside a container, `localhost` is the container itself, unreachable from outside. The server must bind **all network interfaces** (`0.0.0.0`) for Docker's port mapping (`-p 3000:3000`) or Kubernetes to reach it. Forgetting this is the classic "works locally, connection refused in prod" bug.

```dockerfile
USER node
```
From this point on, everything runs as the unprivileged `node` user (uid 1000, shipped with the official image) instead of root. If a vulnerability in your app is ever exploited, the attacker lands as a low-privilege user rather than owning the container. Two words, standard production hygiene.

```dockerfile
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
```
The payoff of the whole multistage setup — only these three things enter the final image:

1. **`.next/standalone` → `./`** — the self-contained server (its `server.js` plus its pruned `node_modules`). This is your entire backend-for-the-frontend. In a single-app repo the paths are clean: the server lands at `/app/server.js`.
2. **`.next/static`** — the compiled client JavaScript/CSS. Next does *not* include this in the standalone output (it assumes you might serve it from a CDN), so it must be copied separately, next to the server.
3. **`public/`** — static files like images and fonts, same story.

`--chown=node:node` makes these files owned by the `node` user. Without it, files copied from an earlier stage are owned by `root`, which conflicts with having just switched to a non-root user.

What's *not* here: no source code, no TypeScript, no webpack, no dev dependencies, no npm CLI usage. That's how this image lands around 150–200MB while a single-stage build of the same app is easily 1.5GB.

```dockerfile
EXPOSE 3000
```
Purely documentation — a note saying "this app listens on 3000". It does **not** publish the port (that's `docker run -p 3000:3000` at runtime, or the `ports:` section in compose/Kubernetes).

```dockerfile
CMD ["node", "server.js"]
```
The command the container runs when it starts. Two things to understand here:

- **What it runs**: the minimal standalone server — no `next` CLI involved.
- **Why the JSON-array "exec form" matters**: in exec form, `node` itself becomes PID 1 (the main process of the container). When you run `docker stop` or Kubernetes terminates a pod, the system sends `SIGTERM` to PID 1 — node receives it directly and can finish in-flight requests before exiting. In shell form (`CMD node server.js`), Docker wraps the command in `/bin/sh`, so *sh* becomes PID 1, ignores `SIGTERM`, and after the ~10-second grace period your running process is force-killed — dropping every user's in-flight request on every single deploy.

---

## One-file trace, start to finish

Follow your own code through the pipeline to cement it:

1. Your React component (`app/page.tsx`) enters at **stage 2** via `COPY . .`.
2. `next build` compiles it into (a) compiled JS chunks in `.next/static`, (b) the server bundle inside `.next/standalone`.
3. **Stage 3** then receives exactly those two outputs plus `public/` — and nothing else ever existed as far as the final image is concerned.

That's the whole trick of multistage: the final image looks like the app was born production-ready, because all the construction mess stayed in stages that Docker discards.

---

## FAQ: why doesn't the `deps` stage remove devDependencies?

Because devDependencies are exactly what the build stages need — and since `deps`/`builder` never ship, there is no reason to slim them down. The only place dev dependencies must be removed is the **final image** — and for Next.js, `output: 'standalone'` does that pruning for you inside the build. If stage 1 ran `npm ci --omit=dev`, stage 2 would fail with `sh: next: command not found`. The full `node_modules` never reaches the runner stage, which is the only place it would matter.
