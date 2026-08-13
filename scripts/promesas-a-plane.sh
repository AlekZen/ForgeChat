#!/usr/bin/env bash
# ============================================================================
# promesas-a-plane.sh — Puente ledger de promesas → tickets de Plane (CAM)
#
# Decisión de Alek (auditoría WhatsApp 12-ago-2026): lo que se le promete a un
# usuario no vive sólo en la base de ForgeChat, vive como ticket en Plane, que es
# donde el equipo (y el agente de código de Camiones Selectos) convierte esas
# respuestas en iniciativas de mejora.
#
# POR QUÉ ES UN SCRIPT Y NO CÓDIGO DEL BACKEND:
# el token de Plane vive en Bitwarden a propósito — la skill plane-cs-ops prohíbe
# leerlo de un .env, y el contenedor forgecrm-backend no tiene vault. Así que el
# puente lo corre un agente/humano con el vault abierto y escribe el folio DE
# VUELTA en la base (columna plane_issue_key). Con eso Alekito sabe, desde su
# propia base, en qué va lo que prometió: "lo tuyo va como CAM-42" en vez de
# volver a prometer lo mismo.
#
# SEGURIDAD: por defecto NO escribe nada (dry-run). Escribe sólo con --apply.
#   bash scripts/promesas-a-plane.sh              # muestra qué subiría
#   bash scripts/promesas-a-plane.sh --apply      # crea los tickets
#   bash scripts/promesas-a-plane.sh --apply --limit 3
#
# Sólo sube promesas de contactos MAPEADOS a un proyecto (hoy: los champions de
# Camiones Selectos → CAM). Un prospecto de IA360 no tiene por qué aparecer en el
# tablero de Camiones Selectos: esas se quedan en el ledger y en tu digest.
# ============================================================================
set -uo pipefail

DB="forgecrm-db"
PLANE_CLI="/home/alek/dev/camiones-selectos/.claude/skills/plane-cs-ops/scripts/plane-request.sh"
APPLY=0
LIMIT=10

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --limit) LIMIT="${2:?--limit requiere número}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; exit 1 ;;
  esac
done

[ -x "$PLANE_CLI" ] || { echo "ERROR: no encuentro el cliente de Plane en $PLANE_CLI" >&2; exit 1; }

psql_q(){ docker exec "$DB" psql -U postgres -d postgres -tAc "$1"; }

# Contactos mapeados a proyecto. Se extiende A MANO: mandar la promesa de un
# contacto al tablero equivocado es peor que no mandarla.
proyecto_de(){
  case "$1" in
    5213321060293|5213321062365|5213338701002|5213312292200|5213317257499|5213319706935) printf 'CAM' ;;
    *) return 1 ;;
  esac
}

echo "=============================================================="
echo " PROMESAS → PLANE   $([ "$APPLY" -eq 1 ] && echo '(APLICANDO)' || echo '(dry-run: no escribe nada)')"
echo "=============================================================="

FILAS="$(psql_q "SELECT f.id
                      || E'\t' || f.contact_number
                      || E'\t' || COALESCE(c.name, f.contact_number)
                      || E'\t' || COALESCE(regexp_replace(f.contact_message, E'[\n\t]+', ' ', 'g'), '')
                      || E'\t' || COALESCE(regexp_replace(f.bot_fallback,   E'[\n\t]+', ' ', 'g'), '')
                      || E'\t' || to_char(f.created_at, 'YYYY-MM-DD HH24:MI')
                      || E'\t' || COALESCE(f.reason, '')
                 FROM coexistence.ia360_bot_failures f
                 LEFT JOIN LATERAL (SELECT name FROM coexistence.contacts
                                     WHERE contact_number = f.contact_number
                                     ORDER BY updated_at DESC LIMIT 1) c ON TRUE
                WHERE f.status = 'abierto'
                  AND f.plane_issue_key IS NULL
                  AND f.contact_number !~ '^52199900[0-9]{5}\$'
                ORDER BY f.created_at
                LIMIT $LIMIT")"

[ -z "$FILAS" ] && { echo "  No hay promesas abiertas pendientes de subir."; exit 0; }

SUBIDAS=0; OMITIDAS=0
while IFS=$'\t' read -r ID NUM NOMBRE PREGUNTA PROMETIDO CUANDO RAZON; do
  [ -z "${ID:-}" ] && continue
  if ! PROY="$(proyecto_de "$NUM")"; then
    echo "  [omitido] #$ID $NOMBRE ($NUM) — contacto sin proyecto mapeado; se queda en el ledger"
    OMITIDAS=$((OMITIDAS+1)); continue
  fi

  TITULO="WhatsApp · $NOMBRE: $(echo "$PREGUNTA" | cut -c1-70)"
  DESC="<p><b>Promesa pendiente con un usuario real, capturada por WhatsApp.</b></p>
<p><b>Quién:</b> $NOMBRE ($NUM)<br/>
<b>Cuándo lo pidió:</b> $CUANDO<br/>
<b>Qué pidió:</b> $PREGUNTA</p>
<p><b>Qué se le contestó:</b> $PROMETIDO</p>
<p><b>Origen:</b> ledger de ForgeChat, fila $ID (motivo: $RAZON). Al cerrar este ticket,
cierra también la promesa: <code>UPDATE coexistence.ia360_bot_failures SET status='cerrado' WHERE id=$ID;</code></p>"

  if [ "$APPLY" -eq 0 ]; then
    echo "  [subiría a $PROY] #$ID $NOMBRE — $TITULO"
    SUBIDAS=$((SUBIDAS+1)); continue
  fi

  BODY="$(jq -nc --arg n "$TITULO" --arg d "$DESC" '{name:$n, description_html:$d}')"
  RESP="$(bash "$PLANE_CLI" --method POST --path "projects/{PROJECT_ID}/issues/" --project-code "$PROY" --body "$BODY" 2>&1)"
  ISSUE_ID="$(echo "$RESP" | jq -r '.id // empty' 2>/dev/null)"
  SEQ="$(echo "$RESP" | jq -r '.sequence_id // empty' 2>/dev/null)"
  if [ -z "$ISSUE_ID" ] || [ -z "$SEQ" ]; then
    echo "  [FALLO] #$ID $NOMBRE — Plane no devolvió ticket: $(echo "$RESP" | tail -2)"
    continue
  fi
  psql_q "UPDATE coexistence.ia360_bot_failures
             SET plane_issue_key='$PROY-$SEQ', plane_issue_id='$ISSUE_ID',
                 plane_state='Backlog', plane_synced_at=NOW()
           WHERE id=$ID" >/dev/null
  echo "  [OK] #$ID $NOMBRE → $PROY-$SEQ"
  SUBIDAS=$((SUBIDAS+1))
done <<< "$FILAS"

echo "--------------------------------------------------------------"
echo "  $([ "$APPLY" -eq 1 ] && echo 'subidas' || echo 'por subir'): $SUBIDAS   omitidas (sin proyecto): $OMITIDAS"
[ "$APPLY" -eq 0 ] && echo "  Nada se escribió. Corre con --apply cuando estés de acuerdo."
# Sin esto, un --apply perfecto sale con código 1 (el último test falla) y
# cualquier `script && verificación` encadenada se rompe sin que nada esté mal.
exit 0
