# ---- Stage 1: build the static bundle -----------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

# ---- Stage 2: serve it ----------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
