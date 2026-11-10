# --- Stage 1: Install production dependencies ---
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app
COPY package*.json ./
# Guarantee node_modules exists for zero-dependency projects (npm ci with
# no deps creates nothing, which would break the COPY --from below).
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p node_modules

# --- Stage 2: Production runner (no package managers) ---
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner

# 1. DevSecOps: Patch underlying Alpine OS vulnerabilities, and ship a
#    CA bundle: without it no verified TLS egress works (RDS, AWS APIs,
#    webhooks) from runtimes using the system store.
RUN apk update && apk upgrade --no-cache && apk add --no-cache ca-certificates

# 2. Set production environment (optimizes Node and prevents dev dependencies)
ENV NODE_ENV=production

WORKDIR /app

# 3. Copy application code, then production dependencies from the builder
# (builder modules win even if the host has its own node_modules).
COPY --chown=node:node . .
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# 4. DevSecOps: Nuke all package managers to eliminate base-image CVEs
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# 5. DevSecOps best practice: do not run the container as root
USER node

EXPOSE {{PORT}}

CMD ["node", "index.js"]
