FROM node:24-bookworm

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
    && npm prune --omit=dev \
    && npm install tsx \
    && npm cache clean --force

ENV NODE_ENV=production

EXPOSE 5173
EXPOSE 5174

CMD ["node", "--import", "tsx", "server/index.ts"]
