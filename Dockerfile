# Zero runtime dependencies means the runtime stage needs nothing but Node and
# the compiled output — no node_modules to copy, nothing to audit at runtime.

# ---- build ---------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

# Dev dependencies are only typescript + @types/node, so this layer is small and
# caches well across source edits.
COPY package.json package-lock.json* ./
COPY packages/core/package.json ./packages/core/
COPY packages/gateway/package.json* ./packages/gateway/
COPY packages/sdk/package.json* ./packages/sdk/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json tsconfig.base.json ./
COPY packages ./packages
RUN npm run build


# ---- runtime -------------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `node` (uid 1000) ships with the image. Running as root would let a gateway
# compromise rewrite the mounted providers/ directory.
RUN mkdir -p /app/data && chown -R node:node /app

# Only the compiled output and each package's manifest — no sources, no tests.
COPY --from=build --chown=node:node /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=node:node /app/packages/core/package.json ./packages/core/
COPY --from=build --chown=node:node /app/packages/gateway/dist ./packages/gateway/dist
COPY --from=build --chown=node:node /app/packages/gateway/package.json ./packages/gateway/
COPY --from=build --chown=node:node /app/packages/gateway/public ./packages/gateway/public
COPY --from=build --chown=node:node /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=build --chown=node:node /app/packages/sdk/package.json ./packages/sdk/

COPY --chown=node:node package.json ./
COPY --chown=node:node providers ./providers
COPY --chown=node:node freeway.config.json ./freeway.config.json

# `@freeway/core` resolves through npm's workspace symlinks, which live in the
# root node_modules — a directory this image otherwise has no reason to carry,
# since there are no runtime dependencies. Recreating just the links keeps the
# resolution working without shipping the toolchain.
RUN mkdir -p node_modules/@freeway \
 && ln -s ../../packages/core    node_modules/@freeway/core \
 && ln -s ../../packages/gateway node_modules/@freeway/gateway \
 && ln -s ../../packages/sdk     node_modules/@freeway/sdk \
 && chown -R node:node node_modules

USER node

EXPOSE 8787
# Bind all interfaces inside the container; docker-compose maps it to localhost.
ENV HOST=0.0.0.0 PORT=8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/gateway/dist/bin.js"]
