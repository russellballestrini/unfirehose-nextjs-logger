# The unfirehose dashboard on Alpine, as small as a Next server with a native
# module goes. Two stages, because a layer never shrinks: the builder compiles
# and traces, the runtime carries only what the server imports.
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
#    socket; the cgroup path works without it, names do not).

# --- builder ------------------------------------------------------
FROM node:24-alpine AS builder

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
COPY apps/extension/package.json apps/extension/
RUN npm ci

COPY . .
# NEXT_STANDALONE turns on output:'standalone' and its monorepo-root file
# tracing — gated so it never changes a local `next dev`/`next build`. Build
# from the app dir: turbo's --filter cannot find the package here, a known
# wart of this monorepo.
RUN cd apps/web && NEXT_STANDALONE=1 npx next build

# --- runtime ------------------------------------------------------
FROM node:24-alpine

# coreutils first — the reason this file is not plain busybox. See the header.
RUN apk add --no-cache coreutils bash openssh-client git curl ca-certificates tmux docker-cli

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
USER node
ENV HOME=/home/node
VOLUME ["/home/node/.unfirehose"]

EXPOSE 3000
# The traced server, not `next start`: standalone ships its own minimal server
# and does not need next on PATH.
CMD ["node", "apps/web/server.js"]
