# Build-Stage: Vite-App + Raum-Server bauen
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Im Docker-Build nutzt die App den mitgelieferten Raum-Server (nginx-Proxy
# unter /rooms); der PeerServer unter /peer bleibt als P2P-Fallback.
ENV VITE_PEER_PATH=/peer
ENV VITE_ROOM_PATH=/rooms
RUN npm run build && npm run build:server

# Raum-Server: eigenes, schlankes Node-Image (Build-Target "rooms")
FROM node:22-alpine AS rooms
WORKDIR /app
COPY --from=build /app/dist-server/rooms.cjs ./rooms.cjs
EXPOSE 9300
CMD ["node", "rooms.cjs"]

# Default-Target: Static-Hosting + Proxys über nginx
FROM nginx:alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
