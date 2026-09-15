FROM node:24-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs cli.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/app/data/shortlist.sqlite
EXPOSE 3000
CMD ["node", "server.mjs"]
