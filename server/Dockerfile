FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    OBLOX_DATA_DIR=/data \
    OBLOX_DISCOVERY_PORT=0 \
    TRUST_PROXY_HOPS=0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY --chown=node:node bundles.js community.js client_address.js discovery.js http_body.js payments.js server.js store_lock.js ./
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
