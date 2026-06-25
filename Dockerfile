FROM node:26-bookworm

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=5173 \
    MAPANIM_ADMIN_PORT=5174 \
    HOST=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci

# Install Chromium's OS dependencies (apt) as their own cacheable layer.
RUN npx playwright install-deps chromium

# Download the Chromium build separately, wrapped in a timeout + retry. The
# Playwright "Chrome for Testing" CDN download has hung indefinitely after
# reaching 100% on some builds (e.g. playwright 1.59.1 / chromium 147), which
# stalls the whole image build for hours. A hard timeout turns such a stall
# into a fast retry instead of a hang. The Playwright version is pinned in
# package.json so the browser build can't silently float onto a broken one.
RUN for attempt in 1 2 3; do \
        echo "playwright chromium download attempt ${attempt}"; \
        timeout 600 npx playwright install chromium && exit 0; \
        echo "attempt ${attempt} failed or stalled; retrying in 10s"; \
        sleep 10; \
    done; \
    echo "playwright chromium download failed after 3 attempts" >&2; \
    exit 1

COPY . .

RUN npm test \
    && npm run build:renderer \
    && npm run build:webapp \
    && npm run build:admin \
    && npm run build:server \
    && npm prune --omit=dev \
    && npm cache clean --force

ENV NODE_ENV=production

# Create writable runtime directories and drop to the unprivileged `node` user
# (uid 1000, provided by the base image) so the container never runs as root.
RUN mkdir -p /app/output /app/presets /app/.tile-cache /app/.metrics \
    && chown -R node:node /app

USER node

EXPOSE 5173
EXPOSE 5174

# Liveness probe via the built-in health endpoint. Uses Node's global fetch so no
# extra package (curl/wget) is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Run the precompiled server (built via `npm run build:server` above), so the
# production image doesn't carry the tsx/TypeScript toolchain.
CMD ["node", "dist/server/index.js"]
