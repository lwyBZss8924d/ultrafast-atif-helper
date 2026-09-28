# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
FROM ${NODE_IMAGE} AS build
WORKDIR /helper
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /opt/ultrafast-atif-helper
COPY --from=build /helper/dist ./dist
COPY package.json LICENSE ./
COPY bin ./bin
USER node
WORKDIR /home/node
ENTRYPOINT ["node", "/opt/ultrafast-atif-helper/bin/ultrafast-atif-helper.mjs"]
CMD ["--help"]
