# syntax=docker/dockerfile:1
FROM node:26-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY packages/keystone-sdk/package*.json ./packages/keystone-sdk/
RUN cd packages/keystone-sdk && npm ci

COPY frontend/package*.json ./frontend/
RUN cd frontend && npm ci

COPY . .
RUN npm run build:sdk && npm run build && cd frontend && npm run build

# ---------- Production stage ----------
FROM node:26-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# The runtime image never invokes npm. `CMD` is `node dist/index.js`, and the
# development compose override builds the `builder` target, which keeps its own
# npm. So the bundled npm is dead weight that ships 8 HIGH-severity advisories
# (brace-expansion, ip-address, pacote, picomatch, sigstore) inherited from the
# base image's npm 10.9.9. Those are invisible to `npm audit` and the OSV
# scanner, which only see package-lock.json; container scanning is what catches
# them. Removing npm removes the whole surface rather than patching it.
RUN rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/packages/keystone-sdk/dist ./packages/keystone-sdk/dist
# The setup wizard serves this directory when KEYSTONE_SETUP_MODE=true; without
# it the documented /setup page 404s and the container only works after manual
# configuration.
COPY --from=builder /app/frontend/dist ./frontend/dist

ENV NODE_ENV=production
EXPOSE 4001

# Run as the same uid the k8s manifests pin (runAsUser: 1000), so bare
# `docker run` and compose get the same posture as the cluster.
RUN chown -R node:node /app
USER node

CMD ["node", "dist/index.js"]
