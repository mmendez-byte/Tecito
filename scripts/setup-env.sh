#!/usr/bin/env bash
# Crea los recursos de Cloudflare de un entorno (KV, D1, colas) y muestra los IDs para pegar en wrangler.jsonc.
# Se corre UNA vez por entorno, desde GitHub Actions (workflow "Setup") o desde cualquier máquina con
# CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID en el entorno. No toca secretos.
set -euo pipefail

ENV="${1:?uso: setup-env.sh staging|production}"
case "$ENV" in
  staging)    SUFFIX="-staging"; QUEUE="tecito-leads-staging"; DB="tecito-staging" ;;
  production) SUFFIX="";         QUEUE="tecito-leads";         DB="tecito" ;;
  *) echo "entorno inválido: $ENV"; exit 1 ;;
esac

echo "== KV =="
npx wrangler kv namespace create "SESSIONS${SUFFIX}" 2>&1 | tee /dev/stderr | grep -oE 'id = "[^"]+"' || true
npx wrangler kv namespace create "METRICS${SUFFIX}"  2>&1 | tee /dev/stderr | grep -oE 'id = "[^"]+"' || true

echo "== D1 =="
npx wrangler d1 create "$DB" 2>&1 | tee /dev/stderr | grep -oE '"database_id": "[^"]+"' || true

echo "== Queues =="
npx wrangler queues create "$QUEUE" || true
npx wrangler queues create "${QUEUE}-dlq" || true

cat <<EOF

Listo. Ahora:
1. Pegá los IDs de KV en wrangler.jsonc, env.$ENV.kv_namespaces (reemplazando REEMPLAZAR_KV_*_$(echo "$ENV" | tr a-z A-Z)),
   y el de D1 en env.$ENV.d1_databases (REEMPLAZAR_D1_$(echo "$ENV" | tr a-z A-Z)). Las tablas las crea el deploy.
2. Cargá los secretos del entorno (ver README, "Secretos").
3. Pusheá; el workflow despliega.
EOF
