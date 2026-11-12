FROM oven/bun:1.4.4-alpine AS dependencies
WORKDIR /app
COPY package.json ./
RUN bun install --production --ignore-scripts

FROM oven/bun:1.4.4-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun certs ./certs
USER bun
CMD ["bun", "src/index.ts"]
