# --- Stage 1: Build dependencies into an isolated venv ---
FROM python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8 AS builder

# Prevent Python from writing .pyc files and buffer stdout for cleaner logs
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install runtime libraries and temporary build tools
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache libpq && \
    apk add --no-cache --virtual .build-deps gcc musl-dev postgresql-dev

COPY requirements.txt .

# Build the venv, install dependencies, then NUKE the package manager
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt gunicorn && \
    /opt/venv/bin/pip uninstall -y pip setuptools && \
    rm -rf /root/.cache/pip

# --- Stage 2: Production runner (no build tools, no pip) ---
FROM python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8 AS runner

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

# Create unprivileged user (Alpine syntax)
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser

# Runtime libraries only (native wheels arrive inside the venv)
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache libpq

# Strip the base image's system pip (the venv already ships without one)
RUN /usr/local/bin/python -m pip uninstall -y setuptools wheel pip && \
    rm -rf /root/.cache/pip

# Block pip re-bootstrap via the stdlib
RUN find / -type d -name "ensurepip" -exec rm -rf {} + || true

# Copy the venv and the application code with explicit ownership
COPY --from=builder --chown=appuser:appgroup /opt/venv /opt/venv
COPY --chown=appuser:appgroup . .

USER appuser
EXPOSE {{PORT}}

# Run Gunicorn using the dynamically injected WSGI module
CMD ["gunicorn", "--bind", "0.0.0.0:{{PORT}}", "--workers", "3", "{{DJANGO_WSGI}}:application"]
