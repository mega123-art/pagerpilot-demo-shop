# Generic service image. Build context: testbed/services
#   docker build -f Dockerfile --build-arg SERVICE=demo-api ... .
FROM node:20-alpine
ARG SERVICE
ARG VERSION
ARG GIT_SHA
ARG CODE_HASH

WORKDIR /app/${SERVICE}
COPY ${SERVICE}/package*.json ./
RUN npm ci --omit=dev
COPY ${SERVICE}/ ./
COPY _shared/ /app/_shared/

# _shared lives outside the service dir, so point module lookup at the deps
ENV NODE_ENV=production \
    NODE_PATH=/app/${SERVICE}/node_modules \
    SERVICE_NAME=${SERVICE} \
    APP_VERSION=${VERSION} \
    GIT_SHA=${GIT_SHA} \
    PORT=3000
LABEL code.hash=${CODE_HASH} git.sha=${GIT_SHA}

EXPOSE 3000
USER node
CMD ["node", "index.js"]
