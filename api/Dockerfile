# Two targets from one file.
#
#   default (built when no --target is given) — what every instance has always got. No AI
#           runtime, no AI dependency: `npm ci --omit=optional` skips the Agent SDK and its
#           platform runtime entirely, so an owner who never wanted the Coach carries none of it.
#   coach                                     — the same image plus the Claude Agent SDK.
#
# Build the opt-in one with:  docker build --target coach ./api
# or through compose with:    API_TARGET=coach docker compose up --build
#
# The stage order matters: Docker builds the *last* stage when none is named, so `default` is
# deliberately last and `coach` sits above it.

# Stand-ins for the named build contexts `mcp` and `frontendlib` (see the COPY --from below):
# a build that passes them replaces these stages; one that does not copies nothing.
FROM scratch AS mcp
FROM scratch AS frontendlib

FROM node:22.23.4-alpine AS base

# Declared on the base stage so both targets inherit the labels and the healthcheck.
ARG VERSION=dev
ARG VCS_REF=dev
ARG BUILD_DATE=unknown

LABEL maintainer="Duarte Santos https://github.com/DuarteSantos8" \
    org.opencontainers.image.title="opengym-api" \
    org.opencontainers.image.description="Backend for Self-hosted gym & body-weight tracker — plan routines, log workouts (supersets & cardio too), track your weight and progress, passkey login. Your data, your server." \
    org.opencontainers.image.source="https://github.com/DuarteSantos8/openGym" \
    org.opencontainers.image.url="https://opengym.ch" \
    org.opencontainers.image.documentation="https://github.com/DuarteSantos8/openGym#readme" \
    org.opencontainers.image.licenses="AGPL-3.0-or-later" \
    org.opencontainers.image.version=$VERSION \
    org.opencontainers.image.revision=$VCS_REF \
    org.opencontainers.image.created=$BUILD_DATE

WORKDIR /app

# The base image is rebuilt on node's schedule, not alpine's: between two node releases the
# alpine packages it ships (openssl above all) fall behind their fixes. Taking the upgrades at
# build time keeps the published image at alpine's current state without waiting for node.
RUN apk upgrade --no-cache

# The unprivileged user Coach jobs drop to. Its uid cannot read /data, which is the control that
# keeps a provider runtime away from users, passkeys and the session secret.
#
# Not optional, and not only for the real providers: canDropPrivileges() fails closed on Linux,
# so in an image without this user *every* job is refused with "no `coach` user exists in this
# image" — including the fixture provider that exists precisely so the loop can be walked before
# an account is connected. It costs one line and no bytes worth measuring.
# Fork (Suslicke/opengym): a fixed uid 10001, so a job can read and refresh a Codex login cache
# that lives on a volume shared with other containers running as 10001 (checkist_codex_home).
RUN adduser -D -H -u 10001 -s /sbin/nologin coach

COPY package.json package-lock.json* ./
# `npm ci` rather than `npm install`: the lockfile is the point of committing one, and the SDK's
# per-platform runtime is resolved from it (musl on this base) rather than from whatever the
# build host happened to be.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# Every module server.js imports from the api root has to be named here: the image carries nothing
# else, and one that is missing only shows at boot, as ERR_MODULE_NOT_FOUND.
COPY server.js oidc.js push-messages.js nudge.js nudge-copy.js verify-error.js password.js rate-limit.js passkeys-store.js device-link.js media.js queue.js sync-stamps.js durable.js admin-socket.js recover.js integrations.js ./
COPY coach ./coach
# Fork (Suslicke/opengym): the MCP tools behind /api/mcp and /api/hub/v1/summary, with the
# frontend lib modules they compute with, at the same paths relative to /app as in the source
# tree (../mcp/src, ../frontend/src/lib). They are outside this build context, so they come in as
# named contexts (`--build-context mcp=mcp/src --build-context frontendlib=frontend/src/lib`,
# what .github/workflows/fork-images.yml passes). Without them the empty stages below stand in,
# the image still boots, and those two routes answer 503. node_modules is linked so the tools
# resolve zod and the MCP SDK from the api's own dependencies.
COPY --from=mcp . /mcp/src
COPY --from=frontendlib . /frontend/src/lib
RUN ln -s /app/node_modules /mcp/node_modules
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]

HEALTHCHECK --interval=5m \
            --timeout=5s \
            --retries=3 \
            CMD wget --spider -q "http://127.0.0.1:${PORT}/api/health" || exit 1

# ---------------------------------------------------------------------------------------------
# The opt-in target. Dropping --omit=optional is the whole difference: it pulls in
# @anthropic-ai/claude-agent-sdk together with the one platform runtime this base needs
# (linux-*-musl), both pinned by the lockfile.
FROM base AS coach
RUN npm ci --omit=dev && npm cache clean --force

# Codex ships as a CLI rather than a library, so it is installed rather than resolved, and
# bubblewrap is its sandbox — a Codex requirement, which is why neither appears in the default
# target or anywhere in this tree until now.
RUN apk add --no-cache bubblewrap \
 && npm install -g @openai/codex@0.160.0 \
 && npm cache clean --force

# Where Codex keeps its refreshable login cache. Deliberately a sibling of /data rather than a
# path inside it: docs/SELF_HOSTING tells owners to back up with `tar czf … data/`, and a live
# refresh token has no business riding along in every archive that instruction produces. Owned
# by `coach` because the job that writes it has already dropped to that user.
RUN mkdir -p /coach-auth && chown coach:coach /coach-auth && chmod 700 /coach-auth
VOLUME ["/coach-auth"]

# ---------------------------------------------------------------------------------------------
# Last, so that a plain `docker build ./api` keeps producing the runtime-free image.
FROM base AS default
# npm itself is only a build-time tool here: the server is started with `node server.js` and
# nothing in it spawns npm. Its bundled dependency tree (tar, brace-expansion, ...) is where
# every vulnerability the image scan ever reported lived — none of them was in a package the
# app uses. Gone from the published image; the coach target keeps npm for the Codex CLI.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
