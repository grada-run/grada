# Stage 1: Install dependencies and build the app
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app

# FIX 1: Upgrade Alpine system packages & upgrade global NPM to patch 'tar' and 'pacote' CVEs
RUN apk upgrade --no-cache && \
    npm install -g npm@12.2.1

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the application code
COPY . .

# Build the Next.js application
# (This requires output: 'standalone' in next.config.ts)
RUN npm run build

# Stage 2: Production environment
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runner
WORKDIR /app

# FIX 2: Upgrade Alpine packages and absolutely destroy npm, yarn, and corepack
# to eliminate all remaining Critical/High container vulnerabilities.
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /opt/yarn-* \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/corepack

ENV NODE_ENV=production
ENV PORT={{PORT}}
ENV HOSTNAME="0.0.0.0"

# Create an unprivileged user and group
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001 -G nodejs

# Copy the standalone output and assign ownership to the unprivileged user
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Switch to the unprivileged user before executing
USER nextjs

EXPOSE {{PORT}}

# Start the standalone Node.js server
CMD ["node", "server.js"]