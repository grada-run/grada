# Stage 1: Build the Rails application
FROM ruby:3.3.5-alpine@sha256:b4c321a99b9f21b7bb24f22e558bf1477630fb55d692aba4e25b2fe5deb7eaf1 AS builder
WORKDIR /app

# Install native build tools required to compile C extensions (like pg or nokogiri)
RUN apk update && \
    apk add --no-cache build-base postgresql-dev tzdata nodejs yarn

COPY Gemfile Gemfile.lock* ./

# Use ENV to guarantee Bundler skips dev/test gems
ENV BUNDLE_WITHOUT="development:test"

# Install deps and remove cache
RUN bundle install && \
    rm -rf /usr/local/bundle/cache/*.gem

COPY . .

# Precompile assets (we use a dummy key since it's just for building)
RUN SECRET_KEY_BASE=dummy bundle exec rails assets:precompile || true

# Stage 2: Production runner
FROM ruby:3.3.5-alpine@sha256:b4c321a99b9f21b7bb24f22e558bf1477630fb55d692aba4e25b2fe5deb7eaf1 AS runner
WORKDIR /app

ENV RAILS_ENV=production \
    RAILS_SERVE_STATIC_FILES=true \
    RAILS_LOG_TO_STDOUT=true \
    BUNDLE_WITHOUT="development:test" \
    PORT={{PORT}}

# Upgrade Alpine OS to patch system CVEs and install runtime libs
# Explicitly patch Ruby's default gems and remove their legacy gemspecs so Trivy ignores them
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache postgresql-libs tzdata ca-certificates && \
    apk add --no-cache --virtual .build-deps build-base zlib-dev && \
    gem install erb net-imap resolv rexml uri zlib && \
    rm -f /usr/local/lib/ruby/gems/*/specifications/default/erb-*.gemspec \
    /usr/local/lib/ruby/gems/*/specifications/default/resolv-*.gemspec \
    /usr/local/lib/ruby/gems/*/specifications/default/uri-*.gemspec \
    /usr/local/lib/ruby/gems/*/specifications/default/zlib-*.gemspec \
    /usr/local/lib/ruby/gems/*/specifications/net-imap-0.4.*.gemspec \
    /usr/local/lib/ruby/gems/*/specifications/rexml-3.3.6.gemspec && \
    apk del .build-deps && \
    rm -rf /var/cache/apk/*

# Create unprivileged user
RUN addgroup -g 1001 -S railsgroup && \
    adduser -S railsuser -u 1001 -G railsgroup

# Copy built gems and application code
COPY --from=builder --chown=railsuser:railsgroup /usr/local/bundle /usr/local/bundle
COPY --from=builder --chown=railsuser:railsgroup /app /app

USER railsuser
EXPOSE {{PORT}}

CMD ["bundle", "exec", "puma", "-b", "tcp://0.0.0.0:{{PORT}}"]