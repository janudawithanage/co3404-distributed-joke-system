FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

# Ensure the cache directory exists inside the image.
# The docker-compose named volume mounts over it, but this
# prevents errors if the container runs without a volume.
RUN mkdir -p /app/cache

EXPOSE 3004

CMD ["node", "server.js"]
