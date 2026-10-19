# AISE Dollar — zero-dependency Node server with a SQLite database.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    AISE_DB=/data/aise.db

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
