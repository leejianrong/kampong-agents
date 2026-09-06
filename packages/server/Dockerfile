# @kampong/server hosted-mode container image (ADR-0013, KAN-1221 -- the
# first V5 implementation card). Lives at packages/server/Dockerfile rather
# than the repo root because the root Dockerfile already exists and is
# scoped to a different, unrelated purpose: containerizing packages/cli for
# local-dev-in-a-container convenience (see its own header comment,
# docker-compose.yml, Makefile's `make up`) -- not a production/hosted
# image. Keeping this one under packages/server/ avoids overloading a single
# root Dockerfile with two unrelated build targets and keeps this package's
# deploy artifact next to the package it builds, matching where
# deploy/helm/kampong-server/ points at it.
#
# Build from the repo root so the build context includes every workspace:
#   docker build -f packages/server/Dockerfile -t kampong-server .
#
# Four stages: a full "deps" install (needed to build), a "build" stage that
# compiles exactly the packages this image needs (apps/canvas, packages/spec,
# packages/engine, packages/server -- NOT packages/cli/exporter, which this
# image never runs), a "prod-deps" install (production dependencies only,
# fresh -- so dev-only tooling like typescript/vitest/eslint never reaches
# the final image), and a slim "runtime" stage assembled from just the built
# dist/ output of those four plus that production node_modules tree.

FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Every workspace's package.json, copied individually (not `COPY . .`) so
# `npm ci` is cached across source-only changes -- same reasoning as the
# root Dockerfile. `npm ci` at the root needs every workspace declared in
# package-lock.json to have its manifest present (even with no source yet)
# to resolve/link the workspace tree correctly; packages/cli and
# packages/exporter are included here for that reason even though this
# image never runs them.
COPY package.json package-lock.json ./
COPY packages/spec/package.json packages/spec/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/exporter/package.json packages/exporter/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/canvas/package.json apps/canvas/package.json

RUN npm ci

FROM deps AS build
COPY . .

# Building packages/server (`tsc -b`, composite project references to
# ../spec and ../engine) transitively builds packages/spec and
# packages/engine first -- TypeScript's build-mode (`-b`) traverses project
# references automatically, so there is no separate build step needed for
# either. apps/canvas's `vite build` needs @kampong/spec/@kampong/engine's
# dist/ already present (it imports both), hence building packages/server
# first, apps/canvas second. Neither packages/cli nor packages/exporter is
# built here -- this image never runs either, and AGENTS.md's "npm run build
# must stay tsc -b at the root, not --workspaces" warning is specifically
# about iteration order across the *whole* graph; scoping to one leaf
# project's own `-b` doesn't have that footgun since it always resolves its
# own references correctly regardless of invocation order.
RUN npm run build --workspace=packages/server
RUN npm run build --workspace=apps/canvas

# Fresh, dev-dependency-free install: same manifests as the `deps` stage,
# but `--omit=dev` so typescript/vitest/eslint/etc. never reach the image
# node_modules copied into the runtime stage below.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/spec/package.json packages/spec/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/exporter/package.json packages/exporter/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/server/package.json packages/server/package.json
COPY apps/canvas/package.json apps/canvas/package.json
# --ignore-scripts: the root package.json's own `prepare` script (`husky`,
# a devDependency) would otherwise fail this install outright -- `husky`
# isn't present in a `--omit=dev` install, and there's no git hooks to wire
# up inside a container anyway. None of this image's actual runtime
# dependencies (fastify, zod, yaml, @mastra/core, the ai-sdk packages) need
# a native postinstall step, so skipping lifecycle scripts entirely is safe
# here.
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# npm workspaces resolves @kampong/spec/@kampong/engine/@kampong/canvas-app
# via symlinks in node_modules pointing at these exact relative paths
# (node_modules/@kampong/spec -> ../../packages/spec, etc.) -- each
# workspace directory below needs its package.json (so "main"/"types"
# resolve) and its built dist/, nothing else from source.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json /app/package-lock.json ./

COPY packages/spec/package.json packages/spec/package.json
COPY --from=build /app/packages/spec/dist packages/spec/dist

COPY packages/engine/package.json packages/engine/package.json
COPY --from=build /app/packages/engine/dist packages/engine/dist

COPY packages/server/package.json packages/server/package.json
COPY --from=build /app/packages/server/dist packages/server/dist

COPY apps/canvas/package.json apps/canvas/package.json
COPY --from=build /app/apps/canvas/dist apps/canvas/dist

EXPOSE 8080
ENV PORT=8080
ENV HOST=0.0.0.0

CMD ["node", "packages/server/dist/main.js"]
