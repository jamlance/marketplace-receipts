# Multi-stage build for Receipts.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/receipts ./apps/receipts
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/receipts
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/receipts/package.json ./apps/receipts/package.json
COPY --from=builder /work/apps/receipts/node_modules ./apps/receipts/node_modules
COPY --from=builder /work/apps/receipts/dist ./apps/receipts/dist
COPY apps/receipts/server.js ./apps/receipts/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/receipts
CMD ["node", "server.js"]
