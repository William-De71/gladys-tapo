# -----------------------------------------------------------------------------
# Tapo integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
#
# ffmpeg is the one system package needed: it turns a camera stream (RTSP, or the
# decrypted MPEG-TS of the proprietary protocol) into the JPEG frame Gladys
# displays. Captures go through pipes only, so no temporary file is ever written.
# -----------------------------------------------------------------------------

FROM node:24-alpine

# dumb-init: correct signal handling (SIGTERM) for a graceful shutdown, which
# here means stopping the event loop before exiting.
# ffmpeg: the image capture itself.
RUN apk add --no-cache dumb-init ffmpeg

WORKDIR /app

# Install the PROD dependencies first (better build cache).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

# The only writable location allowed at runtime.
ENV NODE_ENV=production
VOLUME ["/data"]

# Verbosity of the integration logs, read by the SDK logger on every call.
#
# `info` for the published image: debug logs one line per ONVIF pull per camera,
# which would bury the messages that matter. Built as an ARG so a development
# image can ship the verbose default without a separate Dockerfile:
#   docker build --build-arg LOG_LEVEL=debug -t ghcr.io/william-de71/gladys-tapo:dev .
# Gladys supervises the container itself, so passing an env var by hand is not
# an option: it recreates it from the manifest and the variable would be lost.
ARG LOG_LEVEL=info
ENV LOG_LEVEL=${LOG_LEVEL}

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
