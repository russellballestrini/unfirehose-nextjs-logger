# The unfirehose dashboard on Alpine, as small as a Next server with a native
# module goes. Separate stages, because a layer never shrinks: the builder
# compiles and traces, the runtime carries only what the server imports.
#
# Modelled on arborist/bench/peer/Dockerfile.alpine. The lessons that repo
# paid for on its first Alpine fleets are baked in here:
#
#  - coreutils IN THE RUNTIME. Alpine's `timeout` is busybox's, which signals
#    only the direct child; a probe that times out then leaves a wedged `df`,
#    a black-holed `ssh` or a hung `docker inspect` orphaned and running (it
#    drove a 32GB host into swap on arborist). GNU coreutils' `timeout`
#    (Ubuntu's default) puts the command in its own group and kills the group.
#    Installing coreutils makes `timeout` GNU's, so the probe's own `timeout 8`
#    fences behave as they do on Ubuntu. The Node side kills the process group
#    itself besides (see run() in api/mesh/node), so this is belt AND braces.
#
#  - The tools the server SHELLS OUT TO must be present or a whole page goes
#    dark: bash (the local probe re-execs a POSIX shell), openssh-client (every
#    remote node and the bootstrap), git (the Projects/Code tab), curl (geoip),
#    tmux (the terminals), docker-cli (the Containers tab against a mounted
#    socket; the cgroup path works without it, names do not). procps and lsblk
#    because the local probe reads `ps aux` columns and `lsblk -d -o ...`,
#    which busybox's ps and a missing lsblk do not answer.
#
# Stages: `deps` (toolchain + workspace + npm ci), `builder` (next build),
# `worker` (ingest: tsx over the workspace), and the last
# stage `web` (the traced server). `docker build .` builds web, the last
# stage; `--target worker` builds the worker without running next build.

# --- deps ---------------------------------------------------------
# Pinned by multi-arch index digest: a tag moves, a digest does not. 24.22.1
# carries the eMudhra distrust in its compiled-in root store (Oct 2026).
# Bump every stage together.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps

# better-sqlite3 is native and Alpine is musl: it compiles here against musl,
# and the .node it produces runs in the musl runtime stage unchanged. No
# prebuilt wheel exists to lean on, so the toolchain is required at build time
# and gone from the final image.
RUN apk add --no-cache build-base python3

WORKDIR /repo
# Manifests first, so a source-only change does not reinstall the world.
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
COPY packages/schema/package.json packages/schema/
COPY packages/router/package.json packages/router/
COPY packages/config/package.json packages/config/
RUN npm ci

COPY . .

# --- builder ------------------------------------------------------
FROM deps AS builder
# NEXT_STANDALONE turns on output:'standalone' and its monorepo-root file
# tracing — gated so it never changes a local `next dev`/`next build`. Build
# from the app dir: turbo's --filter cannot find the package here, a known
# wart of this monorepo.
RUN cd apps/web && NEXT_STANDALONE=1 npx next build

# --- worker -------------------------------------------------------
# apps/worker has no build step: it is tsx over TypeScript sources, its own
# and packages/core's. So this stage carries the workspace sources and the
# installed node_modules (tsx and better-sqlite3, already compiled for musl
# in deps), not the web app or its .next output. It ingests, samples the
# mesh (ssh to each node, the local probe through bash and GNU timeout) and
# reads git for project identity, so those tools are here; the compiler
# toolchain is not.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS worker

RUN apk add --no-cache coreutils bash openssh-client git curl ca-certificates procps lsblk

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=4096 \
    HOME=/home/node

WORKDIR /repo
COPY --from=deps /repo/package.json ./
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
COPY --from=deps /repo/apps/worker ./apps/worker

# Our data dir exists in the image, owned by node, so a fresh named volume
# mounted here starts with that ownership (docker copies it up on first
# mount) and the worker can write its SQLite with no root chown step.
RUN mkdir -p /home/node/.unfirehose && chown node:node /home/node/.unfirehose
USER node
VOLUME ["/home/node/.unfirehose"]

WORKDIR /repo/apps/worker
# What the systemd unit runs: `start` (tsx src/main.ts), never `dev`.
CMD ["npm", "run", "start"]

# --- web (runtime) ------------------------------------------------
# Last, so a plain `docker build .` still produces the dashboard image.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS web

# coreutils first — the reason this file is not plain busybox. See the header.
RUN apk add --no-cache coreutils bash openssh-client git curl ca-certificates tmux docker-cli procps lsblk

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app
# The standalone tree is rooted at the workspace, so the server lands at
# apps/web/server.js with node_modules and packages beside it. Static assets
# and public/ are not traced — copied explicitly.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public

# The dashboard reads the operator's own world — ~/.ssh/config for the mesh,
# ~/.claude and friends for the harness journals, and it writes its SQLite to
# ~/.unfirehose. Mount those at run time; nothing about the operator lives in
# the image. Runs as node (uid 1000), which the base image already provides.
# The data dir is created owned by node, as in the worker stage, so a fresh
# named volume comes up writable.
RUN mkdir -p /home/node/.unfirehose && chown node:node /home/node/.unfirehose
USER node
ENV HOME=/home/node
VOLUME ["/home/node/.unfirehose"]

EXPOSE 3000
# The traced server, not `next start`: standalone ships its own minimal server
# and does not need next on PATH.
CMD ["node", "apps/web/server.js"]
