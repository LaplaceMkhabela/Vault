FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

COPY . .

# Expose port (Cloud Run defaults to 8080 but will map process.env.PORT automatically)
EXPOSE 8080

CMD [ "node", "server.js" ]