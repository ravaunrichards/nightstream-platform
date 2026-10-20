FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend ./backend
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "backend/server.js"]
