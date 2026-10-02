# Single-container demo build: Express serves the API and the built React app on one port.
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY frontend/package.json frontend/package.json
# Dev dependencies are needed: the server runs TypeScript through tsx, and Vite builds the frontend.
RUN npm ci --include=dev

COPY . .
RUN npm run build && rm -f .env && mkdir -p /app/data && chown -R node:node /app/data

ENV HOST=0.0.0.0 \
    PORT=8000 \
    SAATHI_DB_PATH=/app/data/saathi.sqlite3
EXPOSE 8000
USER node
CMD ["npm", "start"]
