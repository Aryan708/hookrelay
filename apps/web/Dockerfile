# syntax=docker/dockerfile:1.7
# Build context: repository root.

FROM node:26-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --include-workspace-root=false

FROM deps AS build
# Rewrites (/api -> API) are resolved at build time in standalone mode, so the API address is a build arg.
ARG API_URL=http://api:4000
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone API_URL=${API_URL}
COPY apps/web apps/web
RUN npm run build --workspace apps/web

FROM node:26-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
