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
# Pull in Debian security patches newer than the base image.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
EXPOSE 4319
# Run as the unprivileged `node` user; it needs to own the data dir. If your platform
# mounts the disk as root (writes fail at startup), chown the mount or override the user.
RUN mkdir -p /app/.tower && chown -R node:node /app
USER node
VOLUME ["/app/.tower"]
# Bind 0.0.0.0 so the container is reachable; honour $PORT (Render/Railway/Fly set it,
# default 4319). Set TOWER_TOKEN to require auth.
CMD ["node", "packages/cli/dist/index.js", "serve", "--http", "--host", "0.0.0.0"]
