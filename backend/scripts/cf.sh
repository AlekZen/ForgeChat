#!/usr/bin/env bash
# cf.sh — helper de Cloudflare para DIAPAZO (humanos + agentes Claude/Codex/Hermes).
# Project-aware: lee el token de un .env del PROYECTO (dotenv), no de user-level.
# Orden de búsqueda del token (primero que tenga CLOUDFLARE_API_TOKEN gana):
#   1. variable de entorno ya exportada
#   2. $CF_SECRETS_FILE (si se define)
#   3. <dir-del-script>/../.env   (p.ej. backend/.env de Hermes)
#   4. ./.env
#   5. $HOME/.secrets/cloudflare.env   (fallback user-level)
# Uso:
#   cf verify
#   cf zones
#   cf dns list   <zona|zone_id>
#   cf dns add    <zona|zone_id> <TYPE> <name> <content> [ttl] [proxied(true/false)]
#   cf email status <zona|zone_id>
#   cf email rules  <zona|zone_id>
#   cf api <GET|POST|PUT|PATCH|DELETE> <path /zones/...> [json_body]
set -euo pipefail

_load_cf_env() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && return 0
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  local f
  for f in "${CF_SECRETS_FILE:-}" "$here/../.env" "./.env" "$HOME/.secrets/cloudflare.env"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line#export }"
      case "$line" in
        CLOUDFLARE_*=*|CF_*=*)
          key="${line%%=*}"; val="${line#*=}"
          val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
          export "$key=$val" ;;
      esac
    done < "$f"
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && break
  done
}
_load_cf_env
: "${CLOUDFLARE_API_TOKEN:?Falta CLOUDFLARE_API_TOKEN (ponlo en el .env del proyecto o ~/.secrets/cloudflare.env)}"

API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")

zone_id() {
  local z="$1"
  if [[ "$z" =~ ^[0-9a-f]{32}$ ]]; then echo "$z"; return; fi
  curl -s "${AUTH[@]}" "$API/zones?name=$z" | jq -r '.result[0].id // empty'
}
req() { local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then curl -s -X "$m" "${AUTH[@]}" --data "$b" "$API$p"
  else curl -s -X "$m" "${AUTH[@]}" "$API$p"; fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  verify) req GET /user/tokens/verify | jq . ;;
  zones)  req GET "/zones?per_page=50" | jq -r '.result[] | "\(.id)  \(.name)  [\(.status)]"' ;;
  dns)
    sub="${1:-}"; shift || true
    z="$(zone_id "${1:?zona}")"; shift || true
    case "$sub" in
      list) req GET "/zones/$z/dns_records?per_page=100" | jq -r '.result[] | "\(.type)\t\(.name)\t\(.content)"' ;;
      add)
        TYPE="$1"; NAME="$2"; CONTENT="$3"; TTL="${4:-1}"; PROX="${5:-false}"
        req POST "/zones/$z/dns_records" \
          "$(jq -nc --arg t "$TYPE" --arg n "$NAME" --arg c "$CONTENT" --argjson ttl "$TTL" --argjson px "$PROX" \
             '{type:$t,name:$n,content:$c,ttl:$ttl,proxied:$px}')" | jq '{ok:.success,errors:.errors,id:.result.id}' ;;
      *) echo "dns list|add"; exit 1 ;;
    esac ;;
  email)
    sub="${1:-}"; z="$(zone_id "${2:?zona}")"
    case "$sub" in
      status) req GET "/zones/$z/email/routing" | jq '{enabled:.result.enabled,status:.result.status}' ;;
      rules)  req GET "/zones/$z/email/routing/rules?per_page=50" \
                | jq -r '.result[] | "\(.name // "(catch-all)")\t\(.matchers[0].value // .matchers[0].type)\t\(.actions[0].type)\t\((.actions[0].value//[])|join(","))\t\(.enabled)"' ;;
      *) echo "email status|rules"; exit 1 ;;
    esac ;;
  api)
    M="${1:?METHOD}"; P="${2:?path}"; B="${3:-}"; req "$M" "$P" "$B" | jq . ;;
  *)
    grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
