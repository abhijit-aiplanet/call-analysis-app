# Multi-stage build: build with Node, serve with nginx.
# Used for docker-compose local testing and any non-Vercel container deploy.
# For Vercel, this file is ignored — Vercel uses npm scripts directly.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ARG VITE_CALL_ANALYSIS_API_URL=http://localhost:8007
ENV VITE_CALL_ANALYSIS_API_URL=$VITE_CALL_ANALYSIS_API_URL
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# SPA fallback — any unknown route serves index.html so React Router handles it
RUN echo 'server { listen 80; root /usr/share/nginx/html; index index.html; location / { try_files $uri $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 80
