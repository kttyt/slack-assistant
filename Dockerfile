FROM node:20-alpine

# Запуск под непривилегированным пользователем
WORKDIR /app

# Сначала зависимости — лучше кэшируется
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Затем исходники
COPY src ./src

ENV NODE_ENV=production
USER node

# Healthcheck: контейнер становится unhealthy, если токен протух (эндпоинт отдаёт 503).
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/index.js"]
