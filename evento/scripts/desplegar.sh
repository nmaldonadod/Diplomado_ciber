#!/usr/bin/env bash
# Despliega la plataforma en Cloudflare. Requiere CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID en el entorno.
# Es seguro ejecutarlo varias veces: sólo crea el bucket y los secretos que falten (nunca reemplaza DATA_KEY).
set -euo pipefail
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false
: "${CLOUDFLARE_API_TOKEN:?Falta CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Falta CLOUDFLARE_ACCOUNT_ID}"

npm ci --no-audit --no-fund
npm test

BUCKET=mes-ciberseguridad-fotos
if ! npx wrangler r2 bucket list 2>/dev/null | grep -q "$BUCKET"; then
  echo "→ Creando bucket R2 $BUCKET"
  npx wrangler r2 bucket create "$BUCKET"
fi

# El Worker debe existir para poder guardar secretos: el primer despliegue lo crea.
npx wrangler deploy

SECRETOS=$(npx wrangler secret list 2>/dev/null || echo "[]")
if ! grep -q '"DATA_KEY"' <<<"$SECRETOS"; then
  echo "→ Generando DATA_KEY (clave de cifrado de datos personales)"
  openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put DATA_KEY
fi
if ! grep -q '"TOKEN_CONFIGURACION"' <<<"$SECRETOS"; then
  TOKEN=$(openssl rand -hex 12)
  printf '%s' "$TOKEN" | npx wrangler secret put TOKEN_CONFIGURACION
  echo
  echo "════════════════════════════════════════════════════════════"
  echo " Token para crear el primer administrador en /admin:"
  echo "   $TOKEN"
  echo " (deja de servir apenas exista un administrador)"
  echo "════════════════════════════════════════════════════════════"
fi
echo "✓ Despliegue listo."
