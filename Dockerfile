FROM node:26.8.1-bookworm

ENV NODE_ENV=production \
    PYTHONDONTWRITEBYTECODE=1 \
    RESOUND_OUTPUT_DIR=/data/transcripts \
    RESOUND_DISCORD_PYTHON=/usr/bin/python3

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git libopus0 python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --prod=false
RUN python3 -m pip install --break-system-packages --no-cache-dir -r packages/audio/python/requirements.txt
RUN pnpm clean \
    && pnpm build \
    && pnpm prune --prod \
    && mkdir -p /data/transcripts \
    && chown -R node:node /app /data

USER node
VOLUME ["/data/transcripts"]
CMD ["node", "apps/bot/dist/index.js"]
