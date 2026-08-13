#!/usr/bin/env bash
# ============================================================================
# promesas-desde-plane.sh — Back-sync Plane (CAM) → ledger de promesas
#
# El hermano inverso de promesas-a-plane.sh. Aquel sube la promesa a Plane y
# sella el folio; éste trae de vuelta el estado del ticket y, cuando el ticket
# ya está cerrado (Done) o cancelado (Cancelled), cierra la promesa.
#
# POR QUÉ HACE FALTA: sin back-sync el ledger nunca se cierra. Con `openCount>0`
# el bot le contesta a los champions "Anotado: lo sumo a tus pendientes… los
# anteriores ya se los recordé" en lugar de la promesa normal
# (backend/src/util/botFailureFallback.js), y el contexto del agente sigue
# listando promesas resueltas hace semanas con su folio. Medido 2026-08-12: 25
# filas `abierto`, la más vieja de hace 61 días, 23 con folio que nunca se
# refrescó.
#
# POR QUÉ ES UN SCRIPT DE HOST Y NO CÓDIGO DEL BACKEND: igual que su hermano, el
# cliente de Plane vive fuera del contenedor (el token no está en ningún .env y
# forgecrm-backend no tiene vault). Habla con la base por `docker exec`.
#
# SEGURIDAD: por defecto NO escribe nada (dry-run). Escribe sólo con --apply.
#   bash scripts/promesas-desde-plane.sh              # muestra qué cerraría
#   bash scripts/promesas-desde-plane.sh --apply      # cierra y refresca
#
# Contra Plane sólo hace GET. Nunca borra filas del ledger: cerrar es
# `status='cerrado'`, el mismo valor que documenta promesas-a-plane.sh para el
# cierre manual.
# ============================================================================
set -uo pipefail

DB="forgecrm-db"
PLANE_CLI="/home/alek/dev/camiones-selectos/.claude/skills/plane-cs-ops/scripts/plane-request.sh"
PROJECT_CODE="CAM"
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; exit 1 ;;
  esac
done

[ -x "$PLANE_CLI" ] || { echo "ERROR: no encuentro el cliente de Plane en $PLANE_CLI" >&2; exit 1; }

psql_q(){ docker exec "$DB" psql -U postgres -d postgres -tAc "$1"; }

echo "=============================================================="
echo " PLANE → PROMESAS   $([ "$APPLY" -eq 1 ] && echo '(APLICANDO)' || echo '(dry-run: no escribe nada)')"
echo "=============================================================="

# ── 1. Estados del proyecto: uuid → nombre, uuid → group ────────────────────
# Si Plane no responde se sale ANTES de tocar la base: un mapa vacío haría que
# todas las filas parecieran "sin folio en Plane" y eso es ruido, no un hallazgo.
STATES_ERR="$(mktemp)"
STATES_JSON="$(bash "$PLANE_CLI" --path "projects/{PROJECT_ID}/states/" --project-code "$PROJECT_CODE" 2>"$STATES_ERR")"
STATES_TSV="$(printf '%s' "$STATES_JSON" | jq -r '.results[]? | "\(.id)\t\(.name)\t\(.group)"' 2>/dev/null)"
if [ -z "$STATES_TSV" ]; then
  echo "ERROR: Plane no devolvió estados del proyecto $PROJECT_CODE. No se tocó la base." >&2
  cat "$STATES_ERR" >&2
  printf '%s\n' "$STATES_JSON" | tail -3 >&2
  rm -f "$STATES_ERR"
  exit 1
fi
rm -f "$STATES_ERR"

declare -A STATE_NAME STATE_GROUP
while IFS=$'\t' read -r SID SNAME SGROUP; do
  [ -z "${SID:-}" ] && continue
  STATE_NAME["$SID"]="$SNAME"
  STATE_GROUP["$SID"]="$SGROUP"
done <<< "$STATES_TSV"
echo "  estados leídos: ${#STATE_NAME[@]}"

# ── 2. Issues con paginación: folio (CAM-N) → uuid de estado ────────────────
declare -A ISSUE_STATE
CURSOR=""
PAGINAS=0
while :; do
  if [ -z "$CURSOR" ]; then
    PATH_Q="projects/{PROJECT_ID}/issues/?per_page=100"
  else
    PATH_Q="projects/{PROJECT_ID}/issues/?per_page=100&cursor=$CURSOR"
  fi
  PAGE="$(bash "$PLANE_CLI" --path "$PATH_Q" --project-code "$PROJECT_CODE" 2>/dev/null)"
  PAGE_TSV="$(printf '%s' "$PAGE" | jq -r '.results[]? | "CAM-\(.sequence_id)\t\(.state)"' 2>/dev/null)"
  if [ -z "$PAGE_TSV" ] && [ "$PAGINAS" -eq 0 ]; then
    echo "ERROR: Plane no devolvió issues del proyecto $PROJECT_CODE. No se tocó la base." >&2
    printf '%s\n' "$PAGE" | tail -3 >&2
    exit 1
  fi
  while IFS=$'\t' read -r FOLIO SID; do
    [ -z "${FOLIO:-}" ] && continue
    ISSUE_STATE["$FOLIO"]="$SID"
  done <<< "$PAGE_TSV"
  PAGINAS=$((PAGINAS+1))
  MAS="$(printf '%s' "$PAGE" | jq -r '.next_page_results // false' 2>/dev/null)"
  [ "$MAS" = "true" ] || break
  CURSOR="$(printf '%s' "$PAGE" | jq -r '.next_cursor // empty' 2>/dev/null)"
  [ -n "$CURSOR" ] || break
done
echo "  issues leídos: ${#ISSUE_STATE[@]} (páginas: $PAGINAS)"
echo "--------------------------------------------------------------"

# ── 3. Filas del ledger con folio que siguen abiertas ───────────────────────
FILAS="$(psql_q "SELECT id || E'\t' || plane_issue_key
                   FROM coexistence.ia360_bot_failures
                  WHERE status = 'abierto'
                    AND plane_issue_key IS NOT NULL
                    AND contact_number !~ '^52199900[0-9]{5}\$'
                  ORDER BY id")"

if [ -z "$FILAS" ]; then
  echo "  No hay promesas abiertas con folio de Plane."
  exit 0
fi

CERRADAS=0; ACTUALIZADAS=0; SIN_FOLIO=0
while IFS=$'\t' read -r ID FOLIO; do
  [ -z "${ID:-}" ] && continue

  SID="${ISSUE_STATE[$FOLIO]:-}"
  if [ -z "$SID" ]; then
    echo "  [sin folio en Plane] #$ID $FOLIO"
    SIN_FOLIO=$((SIN_FOLIO+1)); continue
  fi

  NOMBRE="${STATE_NAME[$SID]:-}"
  GRUPO="${STATE_GROUP[$SID]:-}"
  if [ -z "$NOMBRE" ]; then
    echo "  [sin folio en Plane] #$ID $FOLIO (estado $SID desconocido)"
    SIN_FOLIO=$((SIN_FOLIO+1)); continue
  fi
  NOMBRE_SQL="${NOMBRE//\'/\'\'}"

  case "$GRUPO" in
    completed|cancelled)
      if [ "$APPLY" -eq 0 ]; then
        echo "  [cerraría] #$ID $FOLIO → $NOMBRE ($GRUPO)"
      else
        psql_q "UPDATE coexistence.ia360_bot_failures
                   SET status = 'cerrado',
                       plane_state = '$NOMBRE_SQL',
                       plane_synced_at = NOW(),
                       owner_action = COALESCE(owner_action, 'plane_$GRUPO')
                 WHERE id = $ID" >/dev/null
        echo "  [cerrada] #$ID $FOLIO → $NOMBRE ($GRUPO)"
      fi
      CERRADAS=$((CERRADAS+1))
      ;;
    *)
      if [ "$APPLY" -eq 0 ]; then
        echo "  [actualizaría] #$ID $FOLIO → $NOMBRE ($GRUPO)"
      else
        psql_q "UPDATE coexistence.ia360_bot_failures
                   SET plane_state = '$NOMBRE_SQL',
                       plane_synced_at = NOW()
                 WHERE id = $ID" >/dev/null
        echo "  [actualizada] #$ID $FOLIO → $NOMBRE ($GRUPO)"
      fi
      ACTUALIZADAS=$((ACTUALIZADAS+1))
      ;;
  esac
done <<< "$FILAS"

echo "--------------------------------------------------------------"
echo "  cerradas: $CERRADAS   actualizadas: $ACTUALIZADAS   sin folio en Plane: $SIN_FOLIO"
[ "$APPLY" -eq 0 ] && echo "  Nada se escribió. Corre con --apply."
exit 0
