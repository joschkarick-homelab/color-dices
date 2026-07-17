# Build-Stage: Vite-App bauen
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Im Docker-Build nutzt die App den mitgelieferten PeerServer (nginx-Proxy
# unter /peer) statt des öffentlichen PeerJS-Cloud-Brokers.
ENV VITE_PEER_PATH=/peer
RUN npm run build

# Runtime: Static-Hosting + /peer-Proxy über nginx
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
