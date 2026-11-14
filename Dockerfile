FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
STOPSIGNAL SIGTERM
CMD ["node", "src/main.ts", "--daemon"]
