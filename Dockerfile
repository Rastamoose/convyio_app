# Build stage: install the workspace, compile the client bundle.
# Manifests are copied first so source edits don't bust the npm ci layer.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/agent/package.json packages/agent/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build -w @workspace/client

# Runtime stage: server and agent run from TypeScript source via tsx (there
# is no compiled dist for them), so node_modules ships as installed — tsx is
# a dev dependency and pruning dev deps would remove the runtime itself. The
# client ships only its built dist; its source and the Vite toolchain stay
# behind in the build stage.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/packages/agent ./packages/agent
COPY --from=build /app/packages/client/dist ./packages/client/dist
COPY scripts/start.sh scripts/start.sh
EXPOSE 3001
CMD ["./scripts/start.sh"]
