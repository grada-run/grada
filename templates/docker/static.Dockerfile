# STAGE 1: Build the static assets
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app

COPY package*.json ./
# Use clean install for reliable, reproducible builds
RUN npm ci

COPY . .
# Runs the standard build script defined in package.json
RUN npm run build

# STAGE 2: Serve with Hardened Nginx
FROM nginxinc/nginx-unprivileged:alpine
USER root
RUN apk upgrade --no-cache
USER nginx

# Adjusts BUILD_DIR to match your framework's output folder
COPY --from=builder /app/{{BUILD_DIR}} /usr/share/nginx/html

# Inject custom Nginx configuration for unprivileged ports and SPA routing
RUN echo "server {" > /etc/nginx/conf.d/default.conf && \
    echo "    listen {{PORT}};" >> /etc/nginx/conf.d/default.conf && \
    echo "    listen [::]:{{PORT}};" >> /etc/nginx/conf.d/default.conf && \
    echo "    server_name localhost;" >> /etc/nginx/conf.d/default.conf && \
    echo "    location / {" >> /etc/nginx/conf.d/default.conf && \
    echo "        root /usr/share/nginx/html;" >> /etc/nginx/conf.d/default.conf && \
    echo "        index index.html index.htm;" >> /etc/nginx/conf.d/default.conf && \
    echo "        try_files \$uri \$uri/ /index.html;" >> /etc/nginx/conf.d/default.conf && \
    echo "    }" >> /etc/nginx/conf.d/default.conf && \
    echo "}" >> /etc/nginx/conf.d/default.conf

EXPOSE {{PORT}}
CMD ["nginx", "-g", "daemon off;"]