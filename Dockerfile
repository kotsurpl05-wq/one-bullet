FROM node:20-alpine

WORKDIR /app

# Ставим зависимости отдельным слоем, чтобы правки
# кода не инвалидировали кеш npm.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Не запускаем сервер под root.
USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
