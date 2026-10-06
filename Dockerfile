# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RCLONE_IMAGE=rclone/rclone:1.71

# ── Build: compile TypeScript and native deps (better-sqlite3) ─────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ── rclone: static Go binary from the official multi-arch image ────────
FROM ${RCLONE_IMAGE} AS rclone

# ── Runtime ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PHOTOS_DIR=/photos \
    DATABASE_PATH=/database/photo-backup.db \
    RCLONE_CONFIG=/config/rclone/rclone.conf \
    LOG_DIR=/logs \
    PORT=8080 \
    HOME=/tmp

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./

# No credentials in the image: rclone.conf (OAuth token) lives in the /config volume.
RUN mkdir -p /photos /database /config/rclone /logs \
 && chown -R node:node /database /config /logs

USER node
EXPOSE 8080
VOLUME ["/database", "/config", "/logs"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
