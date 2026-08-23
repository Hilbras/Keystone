# syntax=docker/dockerfile:1
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY packages/keystone-sdk/package*.json ./packages/keystone-sdk/
RUN cd packages/keystone-sdk && npm ci

COPY . .
RUN npm run build:sdk && npm run build

# ---------- Production stage ----------
FROM node:22-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/keystone-sdk/dist ./packages/keystone-sdk/dist

ENV NODE_ENV=production
EXPOSE 4001

CMD ["node", "dist/index.js"]
