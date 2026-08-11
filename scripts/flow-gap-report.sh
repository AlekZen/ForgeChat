#!/usr/bin/env bash
# ============================================================================
# flow-gap-report.sh — Radiografía SOLO-LECTURA de los flujos vivos (P16).
#
# Los usuarios reales siguen interactuando y destapan gaps: promesas de respuesta
# que nadie cerró, botones sin ruta, sesiones de Diapazo abandonadas, altas que se
# quedaron a medias. Este reporte imprime esos cuatro frentes con datos de la base
# en segundos, para que Alek (o cualquier agente) audite sin abrir psql a mano.
#
# CERO ESCRITURAS: sólo SELECT. No egresa nada a WhatsApp. Los teléfonos salen
# enmascarados (últimos 4 dígitos).
#
# Uso:  bash scripts/flow-gap-report.sh [días_ventana]     (default: 14)
# ============================================================================
set -uo pipefail

DB="forgecrm-db"
DIAS="${1:-14}"
case "$DIAS" in (''|*[!0-9]*) echo "ABORT: la ventana debe ser un número de días" >&2; exit 2;; esac

psql_t(){ docker exec "$DB" psql -U postgres -d postgres -tAc "$1"; }
psql_p(){ docker exec "$DB" psql -U postgres -d postgres -c "$1"; }

hdr(){ printf '\n\033[1m── %s\033[0m\n' "$1"; }

echo "FLOW GAP REPORT — $(date '+%Y-%m-%d %H:%M:%S') — ventana de labels: ${DIAS} días (solo lectura)"

# ── (a) Ledger de fallos del bot: promesas hechas al contacto ───────────────
hdr "(a1) ia360_bot_failures por status"
psql_p "SELECT COALESCE(status,'(null)') AS status,
               COUNT(*) AS filas,
               COUNT(*) FILTER (WHERE digest_last_at IS NOT NULL) AS con_digest,
               MIN(created_at)::date AS mas_antigua,
               MAX(created_at)::date AS mas_reciente
          FROM coexistence.ia360_bot_failures
         GROUP BY 1
         ORDER BY filas DESC;"

hdr "(a2) top 10 contactos con promesas ABIERTAS (teléfono enmascarado)"
psql_p "SELECT '****'||right(contact_number,4) AS contacto,
               COUNT(*) AS abiertas,
               MIN(created_at)::date AS desde,
               ROUND(EXTRACT(EPOCH FROM (NOW()-MIN(created_at)))/86400)::int AS dias_mas_vieja
          FROM coexistence.ia360_bot_failures
         WHERE status = 'abierto'
         GROUP BY 1
         ORDER BY abiertas DESC, dias_mas_vieja DESC
         LIMIT 10;"

# ── (b) Labels de gap emitidos en la ventana ────────────────────────────────
hdr "(b) labels de gap emitidos en los últimos ${DIAS} días"
psql_p "SELECT template_meta->>'label' AS label,
               COUNT(*) AS veces,
               MAX(created_at)::date AS ultima
          FROM coexistence.chat_history
         WHERE direction = 'outgoing'
           AND created_at > NOW() - INTERVAL '${DIAS} days'
           AND template_meta->>'label' IN (
                 'ia360_fallback_no_silence',
                 'ia360_interactive_fallback',
                 'ia360_boton_sin_ruta',
                 'owner_bot_failure')
         GROUP BY 1
         ORDER BY veces DESC;"

# ── (c) Sesiones de Afinación de Diapazo sin submit ─────────────────────────
hdr "(c) diapazo_sesion_enviada sin respondido_en"
psql_p "SELECT '****'||right(contact_number,4) AS contacto,
               enviado_en::date AS enviada,
               ROUND(EXTRACT(EPOCH FROM (NOW()-enviado_en))/3600)::int AS horas,
               (recordatorio_enviado_at IS NOT NULL) AS recordada
          FROM coexistence.diapazo_sesion_enviada
         WHERE respondido_en IS NULL
         ORDER BY enviado_en DESC
         LIMIT 20;"
echo "   total sin responder: $(psql_t "SELECT COUNT(*) FROM coexistence.diapazo_sesion_enviada WHERE respondido_en IS NULL")"

# ── (d) Altas atoradas: staged sin approve-send tras 48 h ───────────────────
hdr "(d) contactos 'staged' sin ia360-approve-send con más de 48 h"
psql_p "SELECT '****'||right(contact_number,4) AS contacto,
               COALESCE(NULLIF(name,''),'(sin nombre)') AS nombre,
               (custom_fields->>'captured_at')::timestamptz::date AS capturado,
               COALESCE(custom_fields->'ia360_persona_first'->'sequence_candidate'->>'id','(sin secuencia)') AS secuencia,
               COALESCE(custom_fields->>'ia360_owner_notify_suppressed_reason','-') AS aviso_suprimido
          FROM coexistence.contacts
         WHERE custom_fields->>'staged' = 'true'
           AND NOT (COALESCE(tags,'[]'::jsonb) ? 'ia360-approve-send')
           AND (custom_fields->>'captured_at')::timestamptz < NOW() - INTERVAL '48 hours'
           AND contact_number !~ '^52199900[0-9]{5}\$'
         ORDER BY (custom_fields->>'captured_at')::timestamptz DESC
         LIMIT 20;"

echo
echo "Fin del reporte. Ninguna fila fue modificada."
