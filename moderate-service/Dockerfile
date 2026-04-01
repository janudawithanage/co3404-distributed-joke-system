FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# Ensure the cache directory exists inside the image.
# The docker-compose volume will mount over it, but this
# prevents errors if the service runs without a volume.
RUN mkdir -p /app/cache

EXPOSE 4300

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4300/health || exit 1

CMD ["node", "server.js"]
