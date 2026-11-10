# Stage 1: Compile
FROM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS builder
WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /main .

# Stage 2: Production runner
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
WORKDIR /app

# Ship a CA bundle: without it the static binary cannot verify any TLS
# egress (RDS, AWS APIs, webhooks).
RUN apk add --no-cache ca-certificates

# Create unprivileged user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Copy compiled binary with explicit ownership
COPY --from=builder --chown=appuser:appgroup /main /main

USER appuser
EXPOSE {{PORT}}

CMD ["/main"]