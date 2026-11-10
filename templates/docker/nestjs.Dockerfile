# --- Stage 1: Build ---
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- Stage 2: Production ---
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

# 1. DevSecOps: Patch Alpine OS, and ship a CA bundle: without it no
#    verified TLS egress works (RDS, AWS APIs, webhooks) from runtimes
#    using the system store.
RUN apk update && apk upgrade --no-cache && apk add --no-cache ca-certificates

ENV NODE_ENV=production
WORKDIR /app

# 2. Install ONLY production dependencies
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 3. DevSecOps: Nuke all package managers to eliminate base-image CVEs
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack

# 4. Copy the compiled application
COPY --chown=node:node --from=builder /app/dist ./dist

USER node
# Expose the port defined by Terraform
EXPOSE {{PORT}}
CMD ["node", "dist/main.js"]