# syntax=docker/dockerfile:1
# Plataforma de eventos — imagen de producción (servidor Node con SQLite).
FROM node:22.20-alpine3.22 AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
# Sólo dependencias de producción; sin scripts de instalación de terceros.
# Redes con inspección TLS (proxy corporativo): docker build --secret id=ca,src=certificado-ca.pem .
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.20-alpine3.22
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/datos
WORKDIR /app
# El código queda como propiedad de root (sólo lectura para la app); los datos, en un volumen aparte.
COPY --from=dependencias /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config ./config
RUN mkdir -p /datos && chown node:node /datos && chmod 700 /datos
USER node
EXPOSE 8080
VOLUME ["/datos"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/api/cupos').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/node/servidor.js"]
