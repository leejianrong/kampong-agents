# Builds and runs the kampong CLI (packages/cli) inside a container, so
# `kampong dev` doesn't need a matching local Node version -- only a free
# host port, which docker-compose.yml/.env's HOST_PORT makes a one-line
# change instead of a version/toolchain fight (see Makefile). Not a
# production/hosted-mode image (V5 roadmap, not scoped yet) -- this is
# strictly the local-dev-in-a-container convenience AGENTS.md's "single
# command" convention calls for.
FROM node:22-bookworm-slim AS base
WORKDIR /app

# Copy every workspace's package.json before the rest of the source so
# `npm ci` is cached across source-only changes -- npm needs each
# workspace's manifest present (even with no source yet) to resolve the
# lockfile correctly for an `npm ci` at the root.
COPY package.json package-lock.json ./
COPY packages/spec/package.json packages/spec/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/exporter/package.json packages/exporter/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY apps/canvas/package.json apps/canvas/package.json

RUN npm ci

COPY . .

# Root `npm run build` (tsc -b, dependency-order-aware, then vite build for
# apps/canvas) -- deliberately not `npm run build --workspaces`, which
# iterates by directory name rather than the dependency graph and would try
# to build apps/canvas before packages/spec exists (AGENTS.md's own warning
# about this exact footgun).
RUN npm run build

EXPOSE 4310

# ENTRYPOINT fixed to the built CLI binary; CMD (overridable via
# docker-compose's `command:` or `docker compose run app <subcommand> ...`)
# supplies the default subcommand+args, so the same image can also run
# `kampong export`/`kampong run` ad hoc.
ENTRYPOINT ["node", "packages/cli/dist/cli.js"]
CMD ["dev", "/workspace", "--host", "0.0.0.0"]
