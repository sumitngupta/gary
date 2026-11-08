FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    GARY_DATA_DIR=/data \
    PORT=4111
WORKDIR /app
COPY --from=build /src/.mastra/output ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4111
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "index.mjs"]
