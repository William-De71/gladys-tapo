# -----------------------------------------------------------------------------
# Tapo integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see build.yml
#
# ffmpeg is the one system package needed: it turns a camera stream (RTSP, or the
# decrypted MPEG-TS of the proprietary protocol) into the JPEG frame Gladys
# displays. Captures go through pipes only, so no temporary file is ever written.
# -----------------------------------------------------------------------------

FROM node:24-alpine

# Node.js 24.22.1 is the October 2026 security release (Brotli decoder RCE,
# TLS certificate and DNS checks): never build on an older node:24 image.
RUN node -e "const [a, b, c] = process.versions.node.split('.').map(Number); \
  if (a * 1e6 + b * 1e3 + c < 24022001) throw new Error(process.version + ' predates Node.js 24.22.1');"

# The version label and the manifest label are added by build.yml.
LABEL org.opencontainers.image.title="gladys-tapo" \
      org.opencontainers.image.description="TP-Link Tapo cameras, doorbells, plugs, bulbs and hub sensors in Gladys Assistant" \
      org.opencontainers.image.source="https://github.com/William-De71/gladys-tapo" \
      org.opencontainers.image.licenses="Apache-2.0"

# dumb-init: correct signal handling (SIGTERM) for a graceful shutdown, which
# here means stopping the event loop before exiting.
# ffmpeg: the image capture itself.
RUN apk add --no-cache dumb-init ffmpeg

WORKDIR /app

# Install the PROD dependencies first (better build cache). `npm ci` only:
# a lockfile out of sync with package.json must fail the build, not be
# silently re-resolved into an untested dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json LICENSE NOTICE ./

# The only writable location allowed at runtime. Docker creates a new volume
# with the owner of the image's /data, so it must belong to `node`, and before
# VOLUME: changes made to /data after it are discarded.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

ENV LOG_LEVEL=info

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
