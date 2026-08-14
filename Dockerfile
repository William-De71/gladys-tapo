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
# !!! TEMPORARY — REVERT TO `info` BEFORE MERGING !!!
#
# Pinned to `debug` while the ONVIF pull failures (HTTP 400) are being
# diagnosed. It is hard-coded rather than passed as a build ARG because GLADYS
# BUILDS THE IMAGE ITSELF when a developer-mode integration is updated: a
# `--build-arg` given by hand is lost on the next update, and the container came
# back on `info` every time. Same reason an env var on the container does not
# survive — Gladys recreates it from the manifest.
#
# The published image must ship `info`: debug writes one line per ONVIF pull per
# camera, which buries the messages that matter.
ENV LOG_LEVEL=debug

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
