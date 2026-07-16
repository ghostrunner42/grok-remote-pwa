FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

# Create projects folder
RUN mkdir -p projects

EXPOSE 3000

CMD ["node", "server.js"]