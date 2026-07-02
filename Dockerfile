# Tower — hosted HTTP coordination server for a team.
# Build:  docker build -t tower .
# Run:    docker run -p 4319:4319 -e TOWER_TOKEN=your-secret -v tower-data:/app/.tower tower

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
EXPOSE 4319
VOLUME ["/app/.tower"]
# Bind 0.0.0.0 so the container is reachable; set TOWER_TOKEN to require auth.
CMD ["node", "packages/cli/dist/index.js", "serve", "--http", "--port", "4319", "--host", "0.0.0.0"]
