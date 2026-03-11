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

CMD ["node", "server.js"]
