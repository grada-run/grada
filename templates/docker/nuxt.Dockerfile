# Stage 1: Build the Nuxt Nitro output
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app

# Install native build tools required to compile C++ Node modules (like better-sqlite3)
RUN apk update && \
    apk add --no-cache python3 make g++ sqlite-dev

COPY package.json package-lock.json* ./
RUN npm ci

# Explicitly install better-sqlite3 to satisfy Nuxt 4 / Nitro dynamic requirements
RUN npm install better-sqlite3

COPY . .
RUN npm run build

# Stage 2: Production runner
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT={{PORT}}
ENV NITRO_HOST="0.0.0.0"

# 1. Upgrade Alpine OS packages to clear OpenSSL/crypto CVEs
# 2. Vaporize Node package managers (npm, yarn, corepack) to clear ghost CVEs
RUN apk update && apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
    /usr/local/bin/corepack \
    /opt/yarn-*

# Create an unprivileged user and group
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nuxtjs -u 1001 -G nodejs

# Copy the standalone output and assign ownership
COPY --from=builder --chown=nuxtjs:nodejs /app/.output ./.output

USER nuxtjs
EXPOSE {{PORT}}

CMD ["node", ".output/server/index.mjs"]