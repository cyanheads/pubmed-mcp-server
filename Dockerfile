# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to $BUILDPLATFORM so this stage runs natively on the builder instead of
# under emulation. `dist/` is pure JavaScript — tsc output plus tsc-alias path
# rewriting, with no native artifacts — so it is identical across targets, and
# the production stage installs its own runtime dependencies per target.
# Emulating this stage aborts `tsc` on a source tree this size.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building). Lifecycle
# scripts are skipped — the build only runs `tsc`, which needs type declarations,
# not compiled native bindings.
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
# ==============================================================================
FROM oven/bun:1.4.0-slim AS production

WORKDIR /usr/src/app

# Set the environment to production for performance and to ensure only
# production dependencies are installed.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
LABEL org.opencontainers.image.title="@cyanheads/pubmed-mcp-server"
LABEL org.opencontainers.image.description="MCP server for PubMed/NCBI E-utilities. Search articles, fetch metadata, generate citations, explore MeSH terms, and discover related research."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/pubmed-mcp-server"

# Copy dependency manifests
COPY package.json bun.lock ./

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
# `--omit=peer` drops the framework's optional peer tiers (test runner, service
# SDKs, parsers) that Bun would otherwise auto-install. Anything this server
# actually imports belongs in its own `dependencies`, so nothing needed at
# runtime is lost. The OTEL step below carries the same flag — without it, that
# install re-resolves the graph and pulls every optional peer back in.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts

# Conditionally install OpenTelemetry optional peer dependencies (Tier 3).
# These are not bundled by default to keep the base image lean. Enable at build time
# with: docker build --build-arg OTEL_ENABLED=true
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun add --omit=dev --omit=peer --ignore-scripts @hono/otel \
        @opentelemetry/instrumentation-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions; \
    fi

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create and set permissions for the log directory, assigning ownership to the 'bun' user.
RUN mkdir -p /var/log/pubmed-mcp-server && chown -R bun:bun /var/log/pubmed-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/pubmed-mcp-server"
ENV MCP_FORCE_CONSOLE_LOGGING="true"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
