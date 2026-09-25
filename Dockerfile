FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY website ./website
COPY admin.html ./admin.html
RUN npm run website:build

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/website/dist ./website/dist
COPY --from=build /app/website/monitor.html ./website/monitor.html
COPY --from=build /app/website/login.html ./website/login.html
COPY --from=build /app/website/settings.html ./website/settings.html
COPY admin.html ./admin.html
RUN mkdir -p /app/data && chown -R node:node /app

USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "website/dist/server.cjs"]
