# syntax=docker/dockerfile:1.7
# Build context: repository root (npm workspaces share one lockfile).

FROM node:26-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace apps/api --include-workspace-root=false

FROM deps AS build
COPY apps/api apps/api
RUN npm run build --workspace apps/api \
 && npm prune --omit=dev --workspace apps/api

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Run as the unprivileged "node" user; the filesystem is read-only at runtime (see docker-compose).
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/migrations ./migrations
COPY --from=build --chown=node:node /repo/apps/api/openapi.yaml ./openapi.yaml
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "dist/index.js"]
