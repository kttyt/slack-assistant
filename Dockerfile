FROM node:20-alpine

# Запуск под непривилегированным пользователем
WORKDIR /app

# Сначала зависимости — лучше кэшируется. Ставим строго по lock-файлу (воспроизводимо).
# --omit=optional оставляет прокси-пакеты (undici, https-proxy-agent) ВНЕ образа: они нужны
# только при включённом HTTP/S-прокси. Нужен прокси в контейнере — соберите без этого флага.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# Затем исходники
COPY src ./src

ENV NODE_ENV=production
USER node

# Healthcheck: контейнер становится unhealthy, если токен протух (эндпоинт отдаёт 503).
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/index.js"]
