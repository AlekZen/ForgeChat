#!/usr/bin/env bash
# ============================================================================
# qa-pipeline-harness.sh — Harness QA por pipeline (WhatsApp IA360)
#
# Prueba cada pipeline invocando su STARTER/ENDPOINT REAL, nunca TEMPLATE_ID
# directo. Sustituye al helper obsoleto /tmp/send_ia360_pipeline_test.js, que
# contaminaba metadata (pipeline="IA360 100M texto" hardcodeado para todo) y no
# soportaba headers IMAGE. Para envíos de template aislados (modo template_only,
# con soporte IMAGE y metadata veraz) usa scripts/qa-template-send.js.
#
# route_type (clasificación de cada prueba, doc 2026-06-10):
#   template_only          — solo se mandó el template; NO cuenta como pipeline probado.
#   forgechat_monolith_e2e — flujo real del monolito webhook.js (starter + router + estado + deal).
#   n8n_brain_v2_staged    — ruta canary Brain v2 (owner allowlist), staged.
#   new_arch_integrated    — arquitectura nueva integrada (aún no aplica en QA).
#
# Subcomandos:
#   revenue-os <num_qa>       E2E Pipeline "WhatsApp Revenue OS" vía POST
#                             /api/internal/ia360-revenue/opener (starter real).
#   gate-slots-bug <num_qa>   Reproducción del bug canon gate_slots (memoria
#                             ia360-revenue-os-bug): en estado handoff, el click
#                             "Sí, ver horarios" NO debe emitir ia360_os_revenue_ahora_no.
#                             Con STALE=1 inyecta además un "Ahora no" viejo
#                             (OJO: esa rama puede notificar al owner vía fallback global).
#   m100 <num_qa>             Router 100M del monolito: mapa real, anti-loop G-C,
#                             "No prioritario" sin botón Aplicarlo.
#   seq <num_qa> <seq_id> <opcion> <titulo>
#                             Respuesta del contacto a un opener v2 (ids seq_* G-C).
#   hijack <num_qa>           Botón afirmativo huérfano sin opener: evita secuestro
#                             por Revenue OS y responde ia360_boton_sin_ruta.
#   entrega <num_qa>          Quick replies del template de entregable: cubre ack
#                             y posposición sin caer al recovery de Revenue OS.
#   intake <num_qa>           nfm_reply de los dos Flows de intake (ticket TI y orden
#                             de servicio): el acuse debe ECO-ear los campos elegidos.
#   cold-send <num_qa> <persona> <seq_id> [nombre]
#                             Cadena cold-send completa vía owner: vCard → persona →
#                             readout + tarjeta de aprobación (P5: sin selector
#                             intermedio; <seq_id> es la secuencia que el ranker DEBE
#                             auto-elegir) → owner_approve_send. Incluye el caso de
#                             dos vCards en <60 s (P3: la tarjeta no se traga).
#                             *** EGRESA AL OWNER: correr UNA SOLA VEZ por sesión. ***
#   diapazo-alta <num_qa> [nombre]
#                             Alta Diapazo end-to-end: vCard → «Diapazo · Afinación»
#                             → aprobar → template diapazo_sesion_invitacion_v1 con
#                             botón Flow (P1) → submit nfm_reply cierra respondido_en.
#                             *** EGRESA AL OWNER (tarjetas). ***
#   expansion-deal <num_qa> [nombre]
#                             cliente_expansion sin deal vivo: el deal se abre en el
#                             mismo turno y el envío sigue (P6), pasando por
#                             «Cambiar secuencia» (P5). *** EGRESA AL OWNER. ***
#   template-only <num_qa> <template_name> <pipeline> [header_image_url]
#                             Envío de template aislado con metadata veraz (no
#                             marca el pipeline como probado).
#   auditoria <num_qa> [nombre]
#                             Correctivas de la auditoría 2026-08-12: fallback
#                             honesto por clase de mensaje (audio/documento/
#                             imagen), promesa que no se repite, silencio ante
#                             el "Ok" del owner, readout sin jerga y aviso de
#                             contacto con historia previa.
#
# Solo números QA 52199900*. El bot 5213321594582 nunca es contacto. Cero egress
# a contactos reales. Egress técnico a números QA inexistentes: Meta lo acepta o
# lo marca failed async; lo que se audita es chat_history/estado/deals.
# ============================================================================
set -uo pipefail

WA="5213321594582"            # wa_number cuenta IA360 (display_phone_number)
OWNER="5213322638033"         # owner Alek (solo para el subcomando cold-send)
PID_NUM="873315362541590"     # phone_number_id REAL (fix G-D: el inyector debe usarlo)
DB="forgecrm-db"
BE="forgecrm-backend"
REPO="/home/alek/stack/forgechat-poc"
ENVF="$REPO/backend/.env"

APP_SECRET="$(grep -E '^META_APP_SECRET=' "$ENVF" | head -1 | cut -d= -f2-)"
DIR_SECRET="$(grep -E '^IA360_DIRECTIVE_SECRET=' "$ENVF" | head -1 | cut -d= -f2-)"
# Sin secretos no hay HMAC válido: abortar aquí evita corridas que "pasan" sin autenticar.
[ -n "$APP_SECRET" ] || { echo "ABORT: META_APP_SECRET vacío (revisa $ENVF)" >&2; exit 2; }
[ -n "$DIR_SECRET" ] || { echo "ABORT: IA360_DIRECTIVE_SECRET vacío (revisa $ENVF)" >&2; exit 2; }
PORT="$(docker exec "$BE" printenv PORT 2>/dev/null)"; PORT="${PORT:-3011}"
BASE="http://localhost:${PORT}/api"

TEST_RUN="qa-harness.$(date +%s)"
PASS=0; FAIL=0
ok(){ echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad(){ echo "  [FAIL] $1  (esperado~'$3' obtuvo='$2')"; FAIL=$((FAIL+1)); }
chk(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
chk_has(){ if echo "$2" | grep -qF "$3"; then ok "$1"; else bad "$1" "$2" "contiene:$3"; fi; }
chk_not(){ if echo "$2" | grep -qF "$3"; then bad "$1" "contiene $3" "sin $3"; else ok "$1"; fi; }

psql_q(){ docker exec "$DB" psql -U postgres -d postgres -tAc "$1"; }

guard_qa(){ # ningún subcomando acepta números fuera del rango QA; solo dígitos
  # (regex estricta: evita basura tras el prefijo que rompería JSON/SQL embebidos)
  if ! [[ "$1" =~ ^52199900[0-9]{5}$ ]]; then
    echo "ABORT: '$1' no es número QA válido (52199900 + 5 dígitos). Este harness nunca egresa a contactos reales." >&2
    exit 2
  fi
}

NODE_POST='let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{try{const h={"content-type":"application/json"};if(process.env.SIG)h["x-hub-signature-256"]=process.env.SIG;if(process.env.SECRET)h["X-IA360-Directive-Secret"]=process.env.SECRET;const r=await fetch(process.env.URL,{method:"POST",headers:h,body:d});const t=await r.text();process.stdout.write(String(r.status)+(process.env.SHOWBODY?(" "+t):""));}catch(e){process.stdout.write("ERR "+e.message);}});'

post_webhook(){
  local body="$1"
  local sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$APP_SECRET" -r | cut -d' ' -f1)"
  printf '%s' "$body" | docker exec -i -e SIG="$sig" -e URL="$BASE/webhook/whatsapp" "$BE" node -e "$NODE_POST"
}

ts(){ date +%s; }
wamid(){ echo "wamid.${TEST_RUN}.$1.$(ts).$RANDOM"; }

# Inyectores HMAC. entry.id="qa-harness" marca provenance veraz del evento sintético.
_envelope(){ # $1=from $2=profile $3=messages_json
  printf '{"object":"whatsapp_business_account","entry":[{"id":"qa-harness","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"%s","phone_number_id":"%s"},"contacts":[{"wa_id":"%s","profile":{"name":"%s"}}],"messages":[%s]}}]}]}' "$WA" "$PID_NUM" "$1" "$2" "$3"
}
inject_tpl_button(){ # $1=from $2=payload_texto (quick reply de template) $3=profile
  post_webhook "$(_envelope "$1" "${3:-QA Harness}" "{\"from\":\"$1\",\"id\":\"$(wamid tplbtn)\",\"timestamp\":\"$(ts)\",\"type\":\"button\",\"button\":{\"text\":\"$2\",\"payload\":\"$2\"}}")"
}
inject_button(){ # $1=from $2=reply_id $3=title $4=profile
  post_webhook "$(_envelope "$1" "${4:-QA Harness}" "{\"from\":\"$1\",\"id\":\"$(wamid btn)\",\"timestamp\":\"$(ts)\",\"type\":\"interactive\",\"interactive\":{\"type\":\"button_reply\",\"button_reply\":{\"id\":\"$2\",\"title\":\"$3\"}}}")"
}
inject_text(){ # $1=from $2=texto $3=profile $4=wamid (pásalo si luego auditas por ia360_handler_for)
  local id="${4:-$(wamid txt)}"
  post_webhook "$(_envelope "$1" "${3:-QA Harness}" "{\"from\":\"$1\",\"id\":\"$id\",\"timestamp\":\"$(ts)\",\"type\":\"text\",\"text\":{\"body\":\"$2\"}}")"
}
inject_list(){ # $1=from $2=row_id $3=context_msg_id $4=title $5=profile
  post_webhook "$(_envelope "$1" "${5:-QA Harness}" "{\"from\":\"$1\",\"id\":\"$(wamid list)\",\"timestamp\":\"$(ts)\",\"type\":\"interactive\",\"context\":{\"id\":\"$3\"},\"interactive\":{\"type\":\"list_reply\",\"list_reply\":{\"id\":\"$2\",\"title\":\"$4\"}}}")"
}
inject_vcard(){ # $1=from(owner) $2=nombre $3=numero
  post_webhook "$(_envelope "$1" "Alek" "{\"from\":\"$1\",\"id\":\"$(wamid vcard)\",\"timestamp\":\"$(ts)\",\"type\":\"contacts\",\"contacts\":[{\"name\":{\"formatted_name\":\"$2\",\"first_name\":\"$2\"},\"phones\":[{\"phone\":\"+$3\",\"wa_id\":\"$3\",\"type\":\"CELL\"}]}]}")"
}
# HOYO DE QA CERRADO (incidente 2026-08-12): el corte sandbox de sendQueue marca
# la fila como 'sent' y Meta nunca manda su webhook de estado, así que ninguna
# corrida ejercitaba jamás `delivered`, `read` ni `failed`. Un bug que sólo
# aparecía con entrega rápida (delivered) llegó a un contacto real sin que el
# harness pudiera verlo. Este inyector reproduce esos webhooks tal como los manda
# Meta, incluido el bloque `errors` de los fallos.
inject_status(){ # $1=wamid $2=status(sent|delivered|read|failed) $3=recipient $4=error_title(opcional)
  local errs=""
  [ -n "${4:-}" ] && errs=",\"errors\":[{\"code\":131049,\"title\":\"$4\",\"message\":\"$4\"}]"
  post_webhook "$(printf '{"object":"whatsapp_business_account","entry":[{"id":"qa-harness","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"%s","phone_number_id":"%s"},"statuses":[{"id":"%s","status":"%s","timestamp":"%s","recipient_id":"%s"%s}]}}]}]}' "$WA" "$PID_NUM" "$1" "$2" "$(ts)" "$3" "$errs")"
}
last_out_wamid(){ # $1=contacto -> wamid real de su última saliente
  psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$1' ORDER BY id DESC LIMIT 1"
}
inject_nfm(){ # $1=from $2=response_json (JSON plano, se serializa como STRING igual que Meta) $3=profile
  # Meta manda response_json como CADENA dentro del JSON del mensaje. Construir eso a
  # mano en bash es una fuente de escapes rotos: lo arma node y se firma igual que el resto.
  local body
  body="$(FROM="$1" RJ="$2" PROF="${3:-QA Intake}" WAN="$WA" PID="$PID_NUM" MID="$(wamid nfm)" TSV="$(ts)" node -e '
const e=process.env;
process.stdout.write(JSON.stringify({object:"whatsapp_business_account",entry:[{id:"qa-harness",changes:[{field:"messages",value:{
  messaging_product:"whatsapp",
  metadata:{display_phone_number:e.WAN,phone_number_id:e.PID},
  contacts:[{wa_id:e.FROM,profile:{name:e.PROF}}],
  messages:[{from:e.FROM,id:e.MID,timestamp:e.TSV,type:"interactive",
    interactive:{type:"nfm_reply",nfm_reply:{name:"flow",body:"Sent",response_json:e.RJ}}}]
}}]}]}));')"
  post_webhook "$body"
}

# Lecturas de auditoría
max_out_id(){ psql_q "SELECT COALESCE(MAX(id),0) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$1'"; }
fresh_out_label(){ # $1=contact $2=label $3=base_id -> message_body de la saliente NUEVA con ese label
  psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$1' AND id>$3 AND template_meta->>'label'='$2' ORDER BY id DESC LIMIT 1"
}
fresh_count_label(){ psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$1' AND id>$3 AND template_meta->>'label'='$2'"; }
fresh_labels(){ psql_q "SELECT string_agg(template_meta->>'label', ', ' ORDER BY id) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$1' AND id>$2"; }
rev_state(){ psql_q "SELECT custom_fields->>'ia360_revenue_state' FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$1'"; }
p5_stage(){ psql_q "SELECT s.name FROM coexistence.deals d JOIN coexistence.pipeline_stages s ON s.id=d.stage_id JOIN coexistence.pipelines p ON p.id=d.pipeline_id WHERE p.name='WhatsApp Revenue OS' AND d.contact_number='$1' ORDER BY d.updated_at DESC NULLS LAST, d.id DESC LIMIT 1"; }
cf_of(){ psql_q "SELECT custom_fields->>'$2' FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$1'"; }

banner(){
  echo "=============================================================="
  echo "$1"
  echo "  test_run=$TEST_RUN  route_type=$2"
  echo "=============================================================="
}
verdict(){
  echo ""
  echo "--------------------------------------------------------------"
  echo "  RESULTADO ($1):  PASS=$PASS  FAIL=$FAIL  test_run=$TEST_RUN"
  echo "--------------------------------------------------------------"
  [ "$FAIL" -eq 0 ] || exit 1
}

# ───────────────────────────────────────────────────────────────────────────
cmd_revenue_os(){
  local QA="$1"; guard_qa "$QA"
  banner "REVENUE OS E2E — starter real POST /internal/ia360-revenue/opener — contacto QA $QA" "forgechat_monolith_e2e"

  echo "--- STEP 0: limpieza de estado P5 del contacto QA (no toca P2 ni otros contactos) ---"
  psql_q "DELETE FROM coexistence.deals WHERE contact_number='$QA' AND pipeline_id=(SELECT id FROM coexistence.pipelines WHERE name='WhatsApp Revenue OS')" >/dev/null
  psql_q "UPDATE coexistence.contacts SET custom_fields = custom_fields - 'ia360_revenue_state' - 'ia360_revenue_dolor' - 'ia360_revenue_canal' - 'ia360_revenue_volumen' - 'ia360_revenue_calificacion_raw' - 'ia360_revenue_started_at' WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  local BASE_ID; BASE_ID="$(max_out_id "$QA")"
  ok "estado P5 limpio (base chat_history id=$BASE_ID)"

  echo "--- PASO 1: opener vía endpoint real ---"
  local RES; RES="$(printf '%s' "{\"contact_number\":\"$QA\",\"name\":\"QA Revenue OS\"}" | docker exec -i -e SECRET="$DIR_SECRET" -e URL="$BASE/internal/ia360-revenue/opener" -e SHOWBODY=1 "$BE" node -e "$NODE_POST")"
  echo "  opener resp: $RES"
  chk_has "PASO1 endpoint respondió ok" "$RES" '"ok":true'
  sleep 6
  chk "PASO1 estado=apertura_sent" "$(rev_state "$QA")" "apertura_sent"
  chk "PASO1 deal P5 en 'Leads desorganizados'" "$(p5_stage "$QA")" "Leads desorganizados"
  local APERTURA; APERTURA="$(psql_q "SELECT status||' | '||message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_ID AND template_meta->>'template_name'='ia360_os_revenue_apertura' ORDER BY id DESC LIMIT 1")"
  echo "  apertura chat_history: $APERTURA"
  chk_has "PASO1 template apertura registrado" "$APERTURA" "soy la IA de Alek"

  echo "--- PASO 1→2: tap 'Sí, cuéntame' (quick reply del template) ---"
  chk "PASO1→2 HTTP" "$(inject_tpl_button "$QA" "Sí, cuéntame" "QA Revenue OS")" "200"
  sleep 5
  chk "PASO2 estado=calificacion" "$(rev_state "$QA")" "calificacion"
  local P2; P2="$(fresh_out_label "$QA" ia360_os_revenue_paso2 "$BASE_ID")"
  echo "  paso2: $P2"
  chk_has "PASO2 pregunta de calificación" "$P2" "rastro"

  echo "--- PASO 2→3: texto libre de calificación ---"
  local W2; W2="$(wamid calif)"
  chk "PASO2→3 HTTP" "$(inject_text "$QA" "Todo va en un Excel y la memoria, se nos caen como 15 leads al mes" "QA Revenue OS" "$W2")" "200"
  sleep 6
  chk "PASO3 estado=propuesta" "$(rev_state "$QA")" "propuesta"
  chk_has "PASO2 dolor capturado" "$(cf_of "$QA" ia360_revenue_dolor)" "Excel"
  local P3; P3="$(fresh_out_label "$QA" ia360_os_revenue_paso3 "$BASE_ID")"
  echo "  paso3: $P3"
  chk_has "PASO3 botón 'Ver cómo se vería'" "$P3" "Ver cómo se vería"
  chk_has "PASO3 botón 'Hablar con Alek'" "$P3" "Hablar con Alek"
  chk "PASO2 el agente genérico NO respondió (gate cortó)" "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND template_meta->>'ia360_handler_for'='$W2' AND template_meta->>'label' LIKE 'ia360_ai_%'")" "0"

  echo "--- PASO 3 rama A: 'Ver cómo se vería' → demo + deal a Diseño propuesto ---"
  chk "RAMA-A HTTP" "$(inject_button "$QA" "revenue_ver_demo" "Ver cómo se vería" "QA Revenue OS")" "200"
  sleep 5
  chk "RAMA-A estado=demo" "$(rev_state "$QA")" "demo"
  chk "RAMA-A deal P5 → 'Diseño propuesto'" "$(p5_stage "$QA")" "Diseño propuesto"
  chk "RAMA-A demo enviado" "$(fresh_count_label "$QA" ia360_os_revenue_demo "$BASE_ID")" "1"

  echo "--- reset a 'propuesta' para rama B (handoff) ---"
  psql_q "UPDATE coexistence.contacts SET custom_fields = custom_fields || '{\"ia360_revenue_state\":\"propuesta\"}'::jsonb WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  chk "RAMA-B HTTP" "$(inject_button "$QA" "revenue_hablar_alek" "Hablar con Alek" "QA Revenue OS")" "200"
  sleep 5
  chk "RAMA-B estado=handoff" "$(rev_state "$QA")" "handoff"
  local GATE; GATE="$(fresh_out_label "$QA" ia360_os_revenue_gate_agenda "$BASE_ID")"
  echo "  gate: $GATE"
  chk_has "RAMA-B compuerta de agenda con botones" "$GATE" "Sí, ver horarios"

  echo "--- Cero mezcla con el router 100M ---"
  chk "ninguna saliente ia360_100m_* en toda la corrida" "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_ID AND template_meta->>'label' LIKE 'ia360_100m%'")" "0"
  echo "  labels de la corrida: $(fresh_labels "$QA" "$BASE_ID")"
  verdict "Revenue OS E2E ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
cmd_gate_slots_bug(){
  local QA="$1"; guard_qa "$QA"
  banner "BUG gate_slots (memoria ia360-revenue-os-bug) — contacto QA $QA" "forgechat_monolith_e2e"
  local ST; ST="$(rev_state "$QA")"
  if [ "$ST" != "handoff" ]; then
    echo "  [WARN] estado actual='$ST' ≠ handoff → lo siembro por SQL para la reproducción aislada"
    psql_q "UPDATE coexistence.contacts SET custom_fields = custom_fields || '{\"ia360_revenue_state\":\"handoff\"}'::jsonb WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  fi
  local BASE_ID; BASE_ID="$(max_out_id "$QA")"

  echo "--- Repro 1: click 'Sí, ver horarios' (gate_slots_yes) en estado handoff ---"
  echo "    Bug original 2026-06-09 00:30: este click emitía TAMBIÉN ia360_os_revenue_ahora_no."
  chk "R1 HTTP" "$(inject_button "$QA" "gate_slots_yes" "Sí, ver horarios" "QA Revenue OS")" "200"
  sleep 8
  chk "R1 ahora_no NO emitido" "$(fresh_count_label "$QA" ia360_os_revenue_ahora_no "$BASE_ID")" "0"
  chk "R1 estado sigue handoff (sin fuga a nutricion)" "$(rev_state "$QA")" "handoff"
  local SLOTS; SLOTS="$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_ID AND template_meta->>'label' IN ('ia360_lite_available_slots_reslots','ia360_lite_reslots_none')")"
  chk "R1 respuesta de horarios (slots reales o aviso sin huecos)" "$SLOTS" "1"
  echo "  labels tras R1: $(fresh_labels "$QA" "$BASE_ID")"

  if [ "${STALE:-0}" = "1" ]; then
    echo "--- Repro 2 (STALE=1): quick reply viejo 'Ahora no' en estado handoff ---"
    echo "    OJO: si cae al fallback global, notifica al owner (corre esto solo en el bloque final)."
    local BASE2; BASE2="$(max_out_id "$QA")"
    chk "R2 HTTP" "$(inject_tpl_button "$QA" "Ahora no" "QA Revenue OS")" "200"
    sleep 6
    chk "R2 ahora_no NO emitido (gateo por estado funciona)" "$(fresh_count_label "$QA" ia360_os_revenue_ahora_no "$BASE2")" "0"
    chk "R2 estado NO cayó a nutricion" "$(rev_state "$QA")" "handoff"
    echo "  respuesta real a R2: $(fresh_labels "$QA" "$BASE2")"
  else
    echo "  (Repro 2 'Ahora no' stale omitida; corre con STALE=1 en el bloque final con egress al owner)"
  fi
  verdict "bug gate_slots ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
cmd_m100(){
  local QA="$1"; guard_qa "$QA"
  banner "ROUTER 100M (monolito) — contacto QA $QA" "forgechat_monolith_e2e"
  psql_q "UPDATE coexistence.contacts SET custom_fields = custom_fields - 'ia360_100m_visited' WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  local BASE_ID; BASE_ID="$(max_out_id "$QA")"

  echo "--- T1: 'Quiero mapa' entrega mapa real (guardrail f4b56b2, sin offer_router) ---"
  chk "T1 HTTP" "$(inject_button "$QA" "100m_want_map" "Quiero mapa" "QA Cien Eme")" "200"
  sleep 6
  local L1; L1="$(fresh_labels "$QA" "$BASE_ID")"
  echo "  labels: $L1"
  chk_has "T1 responde la rama de mapa" "$L1" "mapa"
  chk_not "T1 NO abre el Flow ia360_offer_router" "$L1" "offer_router"

  echo "--- T2: anti-loop G-C — segunda visita al mismo nodo → versión condensada ---"
  local BASE2; BASE2="$(max_out_id "$QA")"
  chk "T2 HTTP" "$(inject_button "$QA" "100m_want_map" "Quiero mapa" "QA Cien Eme")" "200"
  sleep 6
  chk "T2 respuesta condensada (ia360_100m_condensed)" "$(fresh_count_label "$QA" ia360_100m_condensed "$BASE2")" "1"

  echo "--- T3: 'No prioritario' sin botón 'Aplicarlo' (anti-loop G-C) ---"
  local BASE3; BASE3="$(max_out_id "$QA")"
  chk "T3 HTTP" "$(inject_button "$QA" "100m_not_priority" "No prioritario" "QA Cien Eme")" "200"
  sleep 6
  local R3; R3="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE3 ORDER BY id DESC LIMIT 1")"
  echo "  respuesta: $R3"
  chk_not "T3 sin 'Aplicarlo'" "$R3" "Aplicarlo"
  verdict "router 100M ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
cmd_seq(){
  local QA="$1" SEQ="$2" OPT="$3" TITLE="$4"; guard_qa "$QA"
  banner "OPENERS V2 — respuesta seq_${SEQ}:${OPT} — contacto QA $QA" "forgechat_monolith_e2e"
  psql_q "UPDATE coexistence.contacts SET custom_fields = custom_fields - 'ia360_seq_last_response' WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  local BASE_ID; BASE_ID="$(max_out_id "$QA")"
  chk "HTTP" "$(inject_button "$QA" "seq_${SEQ}:${OPT}" "$TITLE")" "200"
  sleep 6
  local LBL; LBL="$(fresh_labels "$QA" "$BASE_ID")"
  echo "  labels: $LBL"
  chk_has "router seq_* respondió (label ia360_seq_*)" "$LBL" "ia360_seq_"
  chk_has "respuesta registrada en custom_fields" "$(cf_of "$QA" ia360_seq_last_response)" "$OPT"
  verdict "seq ${SEQ}:${OPT} ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
cmd_hijack(){
  guard_qa "$1"
  local QA="$1"
  banner "BUG HIJACK — botón afirmativo huérfano no debe activar Revenue OS — contacto QA $QA" "forgechat_monolith_e2e"

  echo "--- STEP 0: contacto QA limpio, sin evidencia de opener ni entrega ---"
  psql_q "INSERT INTO coexistence.contacts (wa_number, contact_number, name) VALUES ('$WA', '$QA', 'QA Hijack') ON CONFLICT (wa_number, contact_number) DO NOTHING" >/dev/null
  psql_q "UPDATE coexistence.contacts SET custom_fields = custom_fields - 'ia360_persona_first' - 'ia360_revenue_state' - 'ia360_entrega_pendiente' - 'ia360_entrega_state' WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  local BASE_ID; BASE_ID="$(max_out_id "$QA")"

  echo "--- Inyecta quick reply huérfano 'Sí, compártelo' ---"
  chk "HTTP" "$(inject_tpl_button "$QA" "Sí, compártelo" "QA Hijack")" "200"
  sleep 6
  chk "no emitió recovery afirmativo de Revenue OS" "$(fresh_count_label "$QA" ia360_opener_si_recovery "$BASE_ID")" "0"
  local REV; REV="$(rev_state "$QA")"
  if [ "$REV" != "calificacion" ]; then
    ok "estado Revenue OS no fue secuestrado"
  else
    bad "estado Revenue OS no fue secuestrado" "$REV" "distinto de calificacion"
  fi
  chk "respondió con fallback seguro de botón sin ruta" "$(fresh_count_label "$QA" ia360_boton_sin_ruta "$BASE_ID")" "1"
  echo "  labels de la corrida: $(fresh_labels "$QA" "$BASE_ID")"
  verdict "bug hijack ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
cmd_entrega(){
  guard_qa "$1"
  local QA="$1"
  banner "ENTREGA — quick replies del template de seguimiento — contacto QA $QA" "forgechat_monolith_e2e"

  echo "--- STEP 0: contacto QA limpio y template saliente reciente ---"
  psql_q "INSERT INTO coexistence.contacts (wa_number, contact_number, name) VALUES ('$WA', '$QA', 'QA Entrega') ON CONFLICT (wa_number, contact_number) DO NOTHING" >/dev/null
  psql_q "UPDATE coexistence.contacts SET custom_fields = custom_fields - 'ia360_persona_first' - 'ia360_revenue_state' - 'ia360_entrega_pendiente' - 'ia360_entrega_state' WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  local TPL_MID; TPL_MID="wamid.qa-entrega.$(ts).$RANDOM"
  psql_q "INSERT INTO coexistence.chat_history (message_id, phone_number_id, wa_number, contact_number, to_number, direction, message_type, message_body, status, timestamp, created_at, template_meta) VALUES ('$TPL_MID', '$PID_NUM', '$WA', '$QA', '$QA', 'outgoing', 'template', 'ia360_seguimiento_entregable_v1', 'sent', NOW(), NOW(), '{\"template_name\":\"ia360_seguimiento_entregable_v1\"}'::jsonb)" >/dev/null
  local BASE_ID; BASE_ID="$(max_out_id "$QA")"

  echo "--- Rama afirmativa: 'Sí, compártelo' sin entregable precargado ---"
  chk "ACK HTTP" "$(inject_tpl_button "$QA" "Sí, compártelo" "QA Entrega")" "200"
  sleep 6
  echo "--- Rama pospuesta: 'Después' ---"
  chk "POSPUESTA HTTP" "$(inject_tpl_button "$QA" "Después" "QA Entrega")" "200"
  sleep 6
  chk "emitió ack de entrega" "$(fresh_count_label "$QA" ia360_entrega_ack "$BASE_ID")" "1"
  chk "emitió confirmación de entrega pospuesta" "$(fresh_count_label "$QA" ia360_entrega_pospuesta "$BASE_ID")" "1"
  chk "no emitió recovery afirmativo de Revenue OS" "$(fresh_count_label "$QA" ia360_opener_si_recovery "$BASE_ID")" "0"
  echo "  labels de la corrida: $(fresh_labels "$QA" "$BASE_ID")"
  verdict "entrega ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
cmd_cold_send(){
  local QA="$1" PERSONA="$2" SEQ="$3" NAME="${4:-QA Cold Send}"; guard_qa "$QA"
  banner "COLD-SEND vía owner (starter real de secuencias) — $PERSONA/$SEQ → $QA" "forgechat_monolith_e2e"
  echo "  *** Este subcomando EGRESA AL OWNER (tarjetas + confirmación). Una sola corrida por sesión. ***"
  local BASE_OWNER; BASE_OWNER="$(max_out_id "$OWNER")"
  local BASE_QA; BASE_QA="$(max_out_id "$QA")"

  echo "--- C1: vCard del owner → tarjeta de captura ---"
  chk "C1 HTTP" "$(inject_vcard "$OWNER" "$NAME" "$QA")" "200"
  sleep 7
  local CARD; CARD="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_vcard_captured_$QA' ORDER BY id DESC LIMIT 1")"
  if [ -z "$CARD" ]; then bad "C1 tarjeta vCard" "(vacío)" "message_id"; verdict "cold-send"; return; fi
  ok "C1 tarjeta vCard ($CARD)"

  echo "--- C2: persona $PERSONA → readout + tarjeta de aprobación DIRECTOS (P5: sin selector intermedio) ---"
  chk "C2 HTTP" "$(inject_list "$OWNER" "owner_pipe:$QA:$PERSONA" "$CARD" "Persona" "Alek")" "200"
  sleep 8
  chk "C2 NO emitió el selector de secuencias (P5: 2 taps, no 4)" \
      "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_sequence_selector_${QA}_${PERSONA}'")" "0"
  local APR; APR="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label' LIKE 'owner_approve_card_${QA}_%' ORDER BY id DESC LIMIT 1")"
  if [ -z "$APR" ]; then bad "C2 tarjeta de aprobación directa" "(vacío)" "message_id"; verdict "cold-send"; return; fi
  local SEQ_REAL; SEQ_REAL="$(psql_q "SELECT substring(template_meta->>'label' from '^owner_approve_card_${QA}_(.*)\$') FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND message_id='$APR'")"
  ok "C2 tarjeta de aprobación directa ($APR, secuencia=$SEQ_REAL)"
  chk "C2 la secuencia auto-elegida es la esperada" "$SEQ_REAL" "$SEQ"

  echo "--- C3: segundo vCard en <60 s → la tarjeta de aprobación NO se traga (P3) ---"
  local QA2="${QA:0:12}$(( (${QA:12:1} + 1) % 10 ))"
  local BASE_OWNER2; BASE_OWNER2="$(max_out_id "$OWNER")"
  chk "C3 HTTP" "$(inject_vcard "$OWNER" "QA Cold Send Dos" "$QA2")" "200"
  sleep 8
  chk "C3 el segundo contacto recibió tarjeta (captura o aprobación)" \
      "$(psql_q "SELECT CASE WHEN count(*)>0 THEN 'si' ELSE 'no' END FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER2 AND (template_meta->>'label'='owner_vcard_captured_$QA2' OR template_meta->>'label' LIKE 'owner_approve_card_${QA2}_%')")" "si"
  chk "C3 ningún aviso de la cadena de alta quedó suprimido" \
      "$(psql_q "SELECT COALESCE(custom_fields->>'ia360_owner_notify_suppressed_reason','-') FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$QA2'")" "-"

  echo "--- C4: owner_approve_send → opener real al contacto QA ---"
  chk "C4 HTTP" "$(inject_list "$OWNER" "owner_approve_send:$QA:$SEQ_REAL" "$APR" "Aprobar y enviar" "Alek")" "200"
  sleep 8
  local DONE; DONE="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label' IN ('owner_approve_send_done','owner_approve_send_failed') ORDER BY id DESC LIMIT 1")"
  echo "  resultado owner: $DONE"
  chk_has "C4 ack inmediato al owner (P8: sin espera de 9 s)" "$DONE" "Enviando el opener"
  local OPENER; OPENER="$(psql_q "SELECT template_meta->>'label'||' | '||status FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA ORDER BY id DESC LIMIT 1")"
  echo "  opener al QA: $OPENER"
  chk_has "C4 opener registrado para el contacto" "$OPENER" "ia360"
  echo "  deal del QA: $(psql_q "SELECT p.name||' / '||s.name FROM coexistence.deals d JOIN coexistence.pipeline_stages s ON s.id=d.stage_id JOIN coexistence.pipelines p ON p.id=d.pipeline_id WHERE d.contact_number='$QA' ORDER BY d.updated_at DESC NULLS LAST, d.id DESC LIMIT 1")"

  echo "--- C5: respuesta del contacto al opener ('Sí, cuéntame' → alias seq_*) ---"
  local BASE_QA2; BASE_QA2="$(max_out_id "$QA")"
  chk "C5 HTTP" "$(inject_tpl_button "$QA" "Sí, cuéntame" "$NAME")" "200"
  sleep 6
  local L5; L5="$(fresh_labels "$QA" "$BASE_QA2")"
  echo "  labels: $L5"
  chk_has "C5 alias ruteado al paso 2 de la secuencia" "$L5" "ia360_seq_"
  verdict "cold-send $PERSONA/$SEQ ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
# P10/P12: ALTA DIAPAZO end-to-end. vCard del owner → tap «Diapazo · Afinación»
# → «Aprobar y enviar» → el contacto recibe la Sesión de Afinación. Un contacto
# QA nuevo SIEMPRE está fuera de la ventana de 24 h, así que el camino ejercido
# es el template `diapazo_sesion_invitacion_v1` CON su botón de Flow (P1). Cero
# egress: sendQueue corta el rango QA y marca la fila con wamid sintético.
cmd_diapazo_alta(){
  local QA="$1" NAME="${2:-QA Diapazo Alta}"; guard_qa "$QA"
  banner "ALTA DIAPAZO — vCard → persona_diapazo → aprobar → Sesión de Afinación — $QA" "forgechat_monolith_e2e"
  local BASE_OWNER; BASE_OWNER="$(max_out_id "$OWNER")"
  local BASE_QA; BASE_QA="$(max_out_id "$QA")"

  # Con señal Diapazo en el nombre (P11) el alta es 1 TAP: el vCard salta directo
  # al readout + tarjeta de aprobación. Sin señal son 2 taps: tarjeta corta →
  # «Diapazo · Afinación». El harness cubre los dos caminos según el nombre.
  echo "--- D1: vCard del owner ---"
  chk "D1 HTTP" "$(inject_vcard "$OWNER" "$NAME" "$QA")" "200"
  sleep 8
  local APR_SQL="SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_approve_card_${QA}_diapazo_sesion_afinacion' ORDER BY id DESC LIMIT 1"
  local APR; APR="$(psql_q "$APR_SQL")"
  if [ -n "$APR" ]; then
    ok "D1 alta de 1 TAP: señal Diapazo en el nombre → tarjeta de aprobación directa ($APR)"
    chk "D1 no hizo falta la lista de clasificación" \
        "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_vcard_captured_$QA'")" "0"
  else
    local CARD; CARD="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_vcard_captured_$QA' ORDER BY id DESC LIMIT 1")"
    if [ -z "$CARD" ]; then bad "D1 tarjeta vCard" "(vacío)" "message_id"; verdict "diapazo-alta"; return; fi
    ok "D1 tarjeta de clasificación ($CARD)"
    echo "--- D2: tap «Diapazo · Afinación» → readout + tarjeta de aprobación ---"
    chk "D2 HTTP" "$(inject_list "$OWNER" "owner_pipe:$QA:persona_diapazo" "$CARD" "Diapazo" "Alek")" "200"
    sleep 8
    APR="$(psql_q "$APR_SQL")"
    if [ -z "$APR" ]; then bad "D2 tarjeta de aprobación Diapazo" "(vacío)" "message_id"; verdict "diapazo-alta"; return; fi
    ok "D2 tarjeta de aprobación ($APR)"
  fi

  echo "--- D3: «Aprobar y enviar» → sesión entregada + contacto marcado project=diapazo ---"
  chk "D3 HTTP" "$(inject_list "$OWNER" "owner_approve_send:$QA:diapazo_sesion_afinacion" "$APR" "Aprobar y enviar" "Alek")" "200"
  sleep 10
  chk "D3 contacto marcado project=diapazo" "$(cf_of "$QA" project)" "diapazo"
  chk "D3 contacto marcado diapazo_lead"    "$(cf_of "$QA" diapazo_lead)" "true"
  local TOKEN; TOKEN="$(psql_q "SELECT flow_token FROM coexistence.diapazo_sesion_enviada WHERE contact_number='$QA' ORDER BY enviado_en DESC LIMIT 1")"
  echo "  flow_token: $TOKEN"
  chk_has "D3 sesión registrada con flow_token ses_*" "$TOKEN" "ses_"
  local OUT; OUT="$(psql_q "SELECT status||' | '||COALESCE(template_meta->>'template_name','-') FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA ORDER BY id DESC LIMIT 1")"
  echo "  saliente al contacto: $OUT"
  chk_has "D3 salió el template de invitación Diapazo" "$OUT" "diapazo_sesion_invitacion_v1"
  chk_has "D3 cero egress real (wamid sintético → status sent por sandbox QA)" "$OUT" "sent"
  # P1: el componente de botón FLOW con ESTE token es lo que hace que el submit case.
  local JOB; JOB="$(docker exec "$BE" node -e '
const IORedis=require("ioredis");const r=new IORedis(process.env.REDIS_URL||"redis://redis:6379");
(async()=>{const keys=await r.keys("bull:forgecrm-send:*");let found="";
for(const k of keys){const t=await r.type(k);if(t!=="hash")continue;const d=await r.hget(k,"data");if(!d)continue;
 if(d.includes(process.argv[1])&&d.includes("sub_type")){found=d;break;}}
process.stdout.write(found);r.disconnect();})();' "$TOKEN" 2>/dev/null)"
  if [ -n "$JOB" ]; then
    chk_has "D3 el job del template llevaba el botón Flow (sub_type:flow)" "$JOB" '"sub_type":"flow"'
    chk_has "D3 el botón Flow viajó con ESTE flow_token" "$JOB" "$TOKEN"
  else
    echo "  [info] el job de BullMQ ya fue removido de Redis; se verifica el token por el submit (D4)."
  fi
  local ACKO; ACKO="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label' IN ('owner_approve_send_done','owner_approve_send_blocked') ORDER BY id DESC LIMIT 1")"
  echo "  ack al owner: $ACKO"
  chk_has "D3 ack al owner menciona la Sesión de Afinación" "$ACKO" "Sesión de Afinación"

  echo "--- D4: submit del Flow (nfm_reply con el flow_token real) → sesión cerrada ---"
  local BASE_QA2; BASE_QA2="$(max_out_id "$QA")"
  # Payload IDÉNTICO al del Flow publicado (verificado 2026-08-11 contra el submit
  # real del owner): sin c1..c6 la lectura degrada a "no puedo calcular tu Índice".
  chk "D4 HTTP" "$(inject_nfm "$QA" "{\"c1\":\"3\",\"c2\":\"2\",\"c3\":\"4\",\"c4\":\"2\",\"c5\":\"3\",\"c6\":\"1\",\"cuerda\":\"comercial\",\"senales\":[\"duplicacion\"],\"sistemas\":[\"whatsapp\"],\"resultado\":\"QA\",\"urgencia\":\"alta\",\"alcance\":\"toda_la_empresa\",\"camino\":\"recibir_lectura\",\"consent_lectura\":true,\"consent_seguimiento\":true,\"flow_token\":\"$TOKEN\"}" "$NAME")" "200"
  sleep 7
  chk "D4 respondido_en sellado" "$(psql_q "SELECT CASE WHEN respondido_en IS NULL THEN 'null' ELSE 'sellado' END FROM coexistence.diapazo_sesion_enviada WHERE flow_token='$TOKEN'")" "sellado"
  echo "  labels de la respuesta: $(fresh_labels "$QA" "$BASE_QA2")"
  verdict "diapazo-alta ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
# P6/P5: `cliente_expansion` sobre un contacto SIN deal vivo. Antes, aprobar
# terminaba en un bloqueo («Créale el deal y seguir») y obligaba a re-aprobar:
# 7 interacciones para un alta (caso Juan Carlos, 07-16). Ahora el deal se abre
# en el mismo turno y el envío continúa. De paso ejercita «Cambiar secuencia»
# (P5), el único camino al selector completo.
cmd_expansion_deal(){
  local QA="$1" NAME="${2:-QA Expansion Deal}"; guard_qa "$QA"
  banner "EXPANSION SIN DEAL — auto-crear deal y seguir (P6) — $QA" "forgechat_monolith_e2e"
  local BASE_OWNER; BASE_OWNER="$(max_out_id "$OWNER")"
  local BASE_QA; BASE_QA="$(max_out_id "$QA")"
  psql_q "DELETE FROM coexistence.deals WHERE contact_number='$QA'" >/dev/null

  echo "--- E1: vCard → tarjeta de clasificación ---"
  chk "E1 HTTP" "$(inject_vcard "$OWNER" "$NAME" "$QA")" "200"
  sleep 8
  local CARD; CARD="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_vcard_captured_$QA' ORDER BY id DESC LIMIT 1")"
  if [ -z "$CARD" ]; then bad "E1 tarjeta vCard" "(vacío)" "message_id"; verdict "expansion-deal"; return; fi
  ok "E1 tarjeta de clasificación ($CARD)"

  echo "--- E2: persona_cliente → readout directo; luego «Cambiar secuencia» (P5) ---"
  chk "E2 HTTP" "$(inject_list "$OWNER" "owner_pipe:$QA:persona_cliente" "$CARD" "Cliente activo" "Alek")" "200"
  sleep 8
  local APR1; APR1="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label' LIKE 'owner_approve_card_${QA}_%' ORDER BY id DESC LIMIT 1")"
  if [ -z "$APR1" ]; then bad "E2 tarjeta de aprobación directa" "(vacío)" "message_id"; verdict "expansion-deal"; return; fi
  ok "E2 tarjeta de aprobación directa ($APR1)"
  chk "E2 HTTP cambiar-secuencia" "$(inject_button "$OWNER" "owner_seq_change:$QA:persona_cliente" "Cambiar secuencia" "Alek")" "200"
  sleep 8
  local SEL; SEL="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_sequence_selector_${QA}_persona_cliente' ORDER BY id DESC LIMIT 1")"
  if [ -z "$SEL" ]; then bad "E2 selector reabierto por «Cambiar secuencia»" "(vacío)" "message_id"; verdict "expansion-deal"; return; fi
  ok "E2 selector reabierto ($SEL)"

  echo "--- E3: elegir cliente_expansion (exige deal vivo, y NO hay) ---"
  chk "E3 HTTP" "$(inject_list "$OWNER" "owner_seq:$QA:cliente_expansion" "$SEL" "Expansión" "Alek")" "200"
  sleep 8
  local APR; APR="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_approve_card_${QA}_cliente_expansion' ORDER BY id DESC LIMIT 1")"
  if [ -z "$APR" ]; then bad "E3 tarjeta de aprobación de expansión" "(vacío)" "message_id"; verdict "expansion-deal"; return; fi
  ok "E3 tarjeta de aprobación ($APR)"

  echo "--- E4: aprobar → deal creado y envío en el MISMO turno (sin bloqueo) ---"
  local BASE_OWNER2; BASE_OWNER2="$(max_out_id "$OWNER")"
  chk "E4 HTTP" "$(inject_list "$OWNER" "owner_approve_send:$QA:cliente_expansion" "$APR" "Aprobar y enviar" "Alek")" "200"
  sleep 10
  chk "E4 NO emitió oferta de desbloqueo" "$(fresh_count_label "$OWNER" owner_block_exit_offer "$BASE_OWNER2")" "0"
  local DONE; DONE="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER2 AND template_meta->>'label' IN ('owner_approve_send_done','owner_approve_send_failed','owner_approve_send_blocked') ORDER BY id DESC LIMIT 1")"
  echo "  resultado owner: $DONE"
  chk_has "E4 el ack avisa que abrió el deal" "$DONE" "Abrí el deal"
  echo "  deal del QA: $(psql_q "SELECT p.name||' / '||s.name FROM coexistence.deals d JOIN coexistence.pipeline_stages s ON s.id=d.stage_id JOIN coexistence.pipelines p ON p.id=d.pipeline_id WHERE d.contact_number='$QA' ORDER BY d.updated_at DESC NULLS LAST, d.id DESC LIMIT 1")"
  chk "E4 el contacto tiene deal" "$(psql_q "SELECT CASE WHEN count(*)>0 THEN 'si' ELSE 'no' END FROM coexistence.deals WHERE contact_number='$QA'")" "si"
  local OPENER; OPENER="$(psql_q "SELECT template_meta->>'label'||' | '||status FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA ORDER BY id DESC LIMIT 1")"
  echo "  opener al QA: $OPENER"
  chk_has "E4 el opener de expansión salió al contacto" "$OPENER" "ia360_seq_opener_cliente_expansion"
  verdict "expansion-deal ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
# DESENLACES DE ENVÍO — lo que el sandbox nunca ejercitaba y por eso se escapó a
# producción. Dos casos, los dos con webhooks de estado reales de Meta:
#
#   A) ENTREGA RÁPIDA (delivered): el contacto recibió. El owner NO debe recibir
#      ningún aviso de fallo, y un segundo opener distinto debe quedar bloqueado.
#   B) FALLO REAL (failed): el contacto NO recibió. El owner SÍ debe enterarse,
#      por el vigilante de 30 s.
cmd_desenlaces(){
  local QA="$1" NAME="${2:-Ramiro Prueba}"; guard_qa "$QA"
  banner "DESENLACES DE ENVÍO — delivered no es fallo; failed sí avisa — $QA" "forgechat_monolith_e2e"
  # Misma limpieza que la matriz de alta y por la misma razón: sin ella la segunda
  # corrida sobre el mismo QA no vuelve a ver la tarjeta de clasificación ni puede
  # reenviar el opener («un solo opener por contacto» es un guardrail real).
  psql_q "DELETE FROM coexistence.deals WHERE contact_number='$QA'" >/dev/null
  psql_q "DELETE FROM coexistence.chat_history WHERE contact_number='$QA'" >/dev/null
  psql_q "UPDATE coexistence.contacts
             SET custom_fields = COALESCE(custom_fields,'{}'::jsonb)
                   - 'ia360_persona_first' - 'ia360_selector_ranking'
                   - 'ia360_seq_last_response' - 'ia360_triaje'
                   - 'ia360_approve_send_blocked_at' - 'ia360_approve_send_blocked_reason',
                 tags = '{}'
           WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
  local BASE_OWNER; BASE_OWNER="$(max_out_id "$OWNER")"
  local BASE_QA; BASE_QA="$(max_out_id "$QA")"

  echo "--- S1: alta hasta la tarjeta de aprobación ---"
  chk "S1 vCard" "$(inject_vcard "$OWNER" "$NAME" "$QA")" "200"
  sleep 7
  local CARD; CARD="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_vcard_captured_$QA' ORDER BY id DESC LIMIT 1")"
  if [ -z "$CARD" ]; then bad "S1 tarjeta de clasificación" "(vacío)" "message_id"; verdict "desenlaces"; return; fi
  chk "S1 clasificar" "$(inject_list "$OWNER" "owner_pipe:$QA:persona_beta" "$CARD" "Beta" "Alek")" "200"
  sleep 8
  local APR; APR="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label' LIKE 'owner_approve_card_${QA}_%' ORDER BY id DESC LIMIT 1")"
  local SEQ; SEQ="$(psql_q "SELECT substring(template_meta->>'label' from '^owner_approve_card_${QA}_(.*)\$') FROM coexistence.chat_history WHERE message_id='$APR'")"
  if [ -z "$APR" ]; then bad "S1 tarjeta de aprobación" "(vacío)" "message_id"; verdict "desenlaces"; return; fi
  ok "S1 tarjeta de aprobación (secuencia=$SEQ)"

  echo "--- S2 (caso A): aprobar → Meta entrega RÁPIDO (delivered) ---"
  local BASE_OWNER2; BASE_OWNER2="$(max_out_id "$OWNER")"
  chk "S2 aprobar" "$(inject_list "$OWNER" "owner_approve_send:$QA:$SEQ" "$APR" "Aprobar y enviar" "Alek")" "200"
  sleep 8
  local WAMID; WAMID="$(last_out_wamid "$QA")"
  chk "S2 delivered aceptado" "$(inject_status "$WAMID" "delivered" "$QA")" "200"
  sleep 3
  chk "S2 la fila quedó delivered" "$(psql_q "SELECT status FROM coexistence.chat_history WHERE message_id='$WAMID'")" "delivered"
  # El ack correcto salió y NINGÚN aviso de fallo lo contradice.
  chk_has "S2 ack honesto al owner" "$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER2 AND template_meta->>'label'='owner_approve_send_done' ORDER BY id DESC LIMIT 1")" "Enviando el opener"
  echo "  esperando 35 s al vigilante de fallo (no debe decir nada)…"
  sleep 35
  chk "S2 CERO avisos de fallo sobre un mensaje entregado" \
      "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER2 AND template_meta->>'label' LIKE 'owner_approve_send_failed%'")" "0"

  echo "--- S3: reclasificar y volver a aprobar → NO puede salir un segundo opener ---"
  chk "S3 Cambiar" "$(inject_button "$OWNER" "owner_vcard_change:$QA" "Cambiar" "Alek")" "200"
  sleep 7
  local CARD2; CARD2="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_vcard_captured_$QA' ORDER BY id DESC LIMIT 1")"
  chk "S3 otra clasificación" "$(inject_list "$OWNER" "owner_pipe:$QA:persona_referido" "$CARD2" "Referido" "Alek")" "200"
  sleep 8
  local APR2; APR2="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label' LIKE 'owner_approve_card_${QA}_%' ORDER BY id DESC LIMIT 1")"
  local SEQ2; SEQ2="$(psql_q "SELECT substring(template_meta->>'label' from '^owner_approve_card_${QA}_(.*)\$') FROM coexistence.chat_history WHERE message_id='$APR2'")"
  local ANTES; ANTES="$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA")"
  chk "S3 aprobar la segunda" "$(inject_list "$OWNER" "owner_approve_send:$QA:$SEQ2" "$APR2" "Aprobar y enviar" "Alek")" "200"
  sleep 8
  chk "S3 el contacto NO recibió un segundo mensaje" \
      "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA")" "$ANTES"
  chk_has "S3 el owner sabe por qué" \
      "$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' ORDER BY id DESC LIMIT 1")" "YA recibió un opener"

  echo "--- S4 (caso B): un envío que SÍ falla debe avisar ---"
  local QAB="${QA:0:12}$(( (${QA:12:1} + 5) % 10 ))"
  local BASE_OWNER3; BASE_OWNER3="$(max_out_id "$OWNER")"
  inject_vcard "$OWNER" "Fabiola Prueba" "$QAB" >/dev/null; sleep 7
  local CARDB; CARDB="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_vcard_captured_$QAB' ORDER BY id DESC LIMIT 1")"
  inject_list "$OWNER" "owner_pipe:$QAB:persona_beta" "$CARDB" "Beta" "Alek" >/dev/null; sleep 8
  local APRB; APRB="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label' LIKE 'owner_approve_card_${QAB}_%' ORDER BY id DESC LIMIT 1")"
  local SEQB; SEQB="$(psql_q "SELECT substring(template_meta->>'label' from '^owner_approve_card_${QAB}_(.*)\$') FROM coexistence.chat_history WHERE message_id='$APRB'")"
  if [ -z "$APRB" ]; then bad "S4 tarjeta de aprobación" "(vacío)" "message_id"; verdict "desenlaces"; return; fi
  inject_list "$OWNER" "owner_approve_send:$QAB:$SEQB" "$APRB" "Aprobar y enviar" "Alek" >/dev/null; sleep 8
  local WAMIDB; WAMIDB="$(last_out_wamid "$QAB")"
  chk "S4 failed aceptado" "$(inject_status "$WAMIDB" "failed" "$QAB" "Re-engagement message")" "200"
  echo "  esperando 35 s al vigilante…"
  sleep 35
  local AVISO; AVISO="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER3 AND template_meta->>'label' LIKE 'owner_approve_send_failed%' ORDER BY id DESC LIMIT 1")"
  echo "  aviso: ${AVISO:-(ninguno)}"
  chk_has "S4 el owner SÍ se entera del fallo real" "$AVISO" "NO salió"
  verdict "desenlaces ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
# MATRIZ DE ALTA — corre el camino de DEMO completo para CADA clasificación del
# catálogo y dice cuál sirve y cuál se rompe. Es la respuesta a "que no me deje
# en ridículo cuando se lo enseñe a alguien": el mismo camino que haría Alek
# frente a otra persona (compartir vCard → clasificar → aprobar → el contacto
# recibe → el contacto responde), pero con números QA y cero egress real.
#
# Un contacto QA nuevo SIEMPRE está fuera de la ventana de 24 h, así que cada
# fila ejerce el camino frío real: template aprobado por Meta, no texto libre.
alta_matrix_row(){ MATRIX="${MATRIX}$1\n"; }

cmd_alta_matrix(){
  local BASE_NUM="${2:-5219990013}"   # + 3 dígitos por persona
  banner "MATRIZ DE ALTA — todas las clasificaciones del catálogo" "forgechat_monolith_e2e"
  local PERSONAS="persona_beta persona_referido persona_aliado persona_cliente persona_sponsor persona_comercial persona_cfo persona_tecnico persona_diapazo"
  local MATRIX=""
  local i=0
  for P in $PERSONAS; do
    i=$((i+1))
    local QA; QA="$(printf '%s%03d' "$BASE_NUM" "$i")"
    guard_qa "$QA"
    # Re-ejecutable a propósito: sin esta limpieza, una segunda corrida sobre los
    # mismos números toma el camino «este contacto ya está clasificado», la tarjeta
    # de clasificación nunca aparece y la matriz reporta SIN TARJETA. Ese falso rojo
    # ya costó una investigación completa (12-ago-2026).
    psql_q "DELETE FROM coexistence.deals WHERE contact_number='$QA'" >/dev/null
    psql_q "UPDATE coexistence.contacts
               SET custom_fields = COALESCE(custom_fields,'{}'::jsonb)
                     - 'ia360_persona_first' - 'ia360_selector_ranking'
                     - 'ia360_seq_last_response' - 'ia360_triaje'
                     - 'ia360_approve_send_blocked_at' - 'ia360_approve_send_blocked_reason',
                   tags = '{}'
             WHERE wa_number='$WA' AND contact_number='$QA'" >/dev/null
    # Y el historial del QA: «un solo opener por contacto» es un guardrail REAL de
    # producción (bf9b3e0), así que sin borrar sus salientes la segunda corrida
    # quedaría bloqueada en opener_ya_enviado y no probaría el envío. Sólo toca
    # números QA — guard_qa ya lo garantizó.
    psql_q "DELETE FROM coexistence.chat_history WHERE contact_number='$QA'" >/dev/null
    echo ""
    echo "═══ $P → $QA ═══"
    local BASE_OWNER; BASE_OWNER="$(max_out_id "$OWNER")"
    local BASE_QA; BASE_QA="$(max_out_id "$QA")"

    # 1) vCard con nombre NEUTRO (sin señal): el camino más común.
    chk "$P · vCard aceptado" "$(inject_vcard "$OWNER" "QA Alta $i" "$QA")" "200"
    sleep 7
    local CARD; CARD="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label'='owner_vcard_captured_$QA' ORDER BY id DESC LIMIT 1")"
    if [ -z "$CARD" ]; then bad "$P · tarjeta de clasificación" "(vacío)" "message_id"; alta_matrix_row "$P|SIN TARJETA|-|-|-"; continue; fi

    # 2) tap de la clasificación → readout + tarjeta de aprobación (P5: directo).
    chk "$P · tap de clasificación" "$(inject_list "$OWNER" "owner_pipe:$QA:$P" "$CARD" "Clasificar" "Alek")" "200"
    sleep 8
    local APR; APR="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER AND template_meta->>'label' LIKE 'owner_approve_card_${QA}_%' ORDER BY id DESC LIMIT 1")"
    if [ -z "$APR" ]; then
      bad "$P · tarjeta de aprobación" "(vacío)" "message_id"
      echo "  labels emitidos: $(fresh_labels "$OWNER" "$BASE_OWNER")"
      alta_matrix_row "$P|SIN TARJETA DE APROBACION|-|-|-"; continue
    fi
    local SEQ; SEQ="$(psql_q "SELECT substring(template_meta->>'label' from '^owner_approve_card_${QA}_(.*)\$') FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND message_id='$APR'")"
    ok "$P · tarjeta de aprobación (secuencia=$SEQ)"

    # 3) aprobar → el contacto recibe.
    local BASE_OWNER2; BASE_OWNER2="$(max_out_id "$OWNER")"
    chk "$P · aprobar y enviar" "$(inject_list "$OWNER" "owner_approve_send:$QA:$SEQ" "$APR" "Aprobar y enviar" "Alek")" "200"
    sleep 10
    local ACK; ACK="$(psql_q "SELECT template_meta->>'label' FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER2 AND template_meta->>'label' IN ('owner_approve_send_done','owner_approve_send_failed','owner_approve_send_blocked','owner_block_exit_offer') ORDER BY id DESC LIMIT 1")"
    local OUT; OUT="$(psql_q "SELECT COALESCE(template_meta->>'template_name', template_meta->>'label')||' ['||status||']' FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA ORDER BY id DESC LIMIT 1")"
    echo "  ack owner: ${ACK:-(ninguno)}   salida al contacto: ${OUT:-(ninguna)}"
    local ENVIO="NO SALIÓ"
    case "$OUT" in *"[sent]"*|*"[delivered]"*|*"[read]"*) ENVIO="OK";; esac
    chk "$P · el contacto recibió algo" "$ENVIO" "OK"

    # 4) respuesta del contacto → paso 2 de la secuencia (o cierre de sesión Diapazo).
    local BASE_QA2; BASE_QA2="$(max_out_id "$QA")"
    local RESP="-"
    if [ "$P" = "persona_diapazo" ]; then
      local TOKEN; TOKEN="$(psql_q "SELECT flow_token FROM coexistence.diapazo_sesion_enviada WHERE contact_number='$QA' ORDER BY enviado_en DESC LIMIT 1")"
      inject_nfm "$QA" "{\"c1\":\"3\",\"c2\":\"2\",\"c3\":\"4\",\"c4\":\"2\",\"c5\":\"3\",\"c6\":\"1\",\"cuerda\":\"comercial\",\"camino\":\"recibir_lectura\",\"consent_lectura\":true,\"flow_token\":\"$TOKEN\"}" "QA Alta $i" >/dev/null
      sleep 7
      RESP="$(psql_q "SELECT CASE WHEN respondido_en IS NULL THEN 'SESION NO CERRÓ' ELSE 'OK' END FROM coexistence.diapazo_sesion_enviada WHERE flow_token='$TOKEN'")"
    else
      # id real del primer botón del opener, leído del catálogo que corre en prod.
      local OPT; OPT="$(docker exec "$BE" node -e "
const s=require('fs').readFileSync('/app/src/routes/webhook.js','utf8');
const m=s.match(new RegExp('seq_'+process.argv[1]+':[a-z_]+'));
process.stdout.write(m?m[0]:'');" "$SEQ" 2>/dev/null)"
      if [ -z "$OPT" ]; then
        RESP="SIN OPCIONES DE OPENER"
      else
        inject_button "$QA" "$OPT" "Respuesta QA" "QA Alta $i" >/dev/null
        sleep 7
        local L; L="$(fresh_labels "$QA" "$BASE_QA2")"
        # OK = el contacto recibió el PASO 2 real de la secuencia. El acuse
        # genérico ("registré tu respuesta…") cuenta como gap de contenido: rutea,
        # pero deja la conversación sin siguiente pregunta.
        case "$L" in
          *ia360_seq_step2_*) RESP="OK";;
          *ia360_seq_ack_*)   RESP="ACK GENÉRICO (falta paso 2)";;
          *)                  RESP="NO RUTEÓ (${L:-sin salida})";;
        esac
      fi
    fi
    chk "$P · la respuesta del contacto rutea" "$RESP" "OK"
    local DEAL; DEAL="$(psql_q "SELECT p.name||' / '||s.name FROM coexistence.deals d JOIN coexistence.pipeline_stages s ON s.id=d.stage_id JOIN coexistence.pipelines p ON p.id=d.pipeline_id WHERE d.contact_number='$QA' ORDER BY d.updated_at DESC NULLS LAST, d.id DESC LIMIT 1")"
    alta_matrix_row "$P|$SEQ|$ENVIO|$RESP|${DEAL:-(sin deal)}"
  done

  echo ""
  echo "=============================================================="
  echo " MATRIZ DE ALTA (clasificación | secuencia auto | envío | respuesta | deal)"
  echo "=============================================================="
  printf "$MATRIX" | column -t -s '|'
  verdict "alta-matrix"
}

# ───────────────────────────────────────────────────────────────────────────
cmd_template_only(){
  local QA="$1" TPL="$2" PIPE="$3" IMG="${4:-}"; guard_qa "$QA"
  banner "TEMPLATE-ONLY — $TPL → $QA (NO cuenta como pipeline probado)" "template_only"
  docker cp "$REPO/scripts/qa-template-send.js" "$BE":/app/qa-template-send.js >/dev/null
  docker exec -e TEMPLATE_NAME="$TPL" -e TO="$QA" -e PIPELINE="$PIPE" -e TEST_RUN="$TEST_RUN" \
    -e EXPECTED_HANDLER="${EXPECTED_HANDLER:-}" -e HEADER_IMAGE_URL="$IMG" \
    -e SAMPLE_VALUES="${SAMPLE_VALUES:-{\"1\":\"QA\"}}" "$BE" node /app/qa-template-send.js
  local RC=$?
  chk "encolado template_only" "$RC" "0"
  sleep 5
  echo "  chat_history: $(psql_q "SELECT status||' | '||COALESCE(error_message,'-')||' | '||(raw_payload->'interactive'->>'pipeline')||' | '||(raw_payload->'interactive'->>'route_type') FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND raw_payload->'interactive'->>'test_run'='$TEST_RUN' ORDER BY id DESC LIMIT 1")"
  verdict "template-only $TPL ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
# G7-CONGRUENCIA: los dos Flows de intake (ticket TI / orden de servicio). Lo que
# se prueba NO es que responda, sino que el acuse ECO-ee los campos que el contacto
# eligió: es la evidencia observable de que el sistema entendió SU caso y no soltó
# una plantilla genérica. Un eco que no refleje el input es un FAIL duro.
cmd_intake(){
  local QA="$1"; guard_qa "$QA"
  banner "INTAKE FLOWS — eco dinámico de ticket TI y orden de servicio — contacto QA $QA" "forgechat_monolith_e2e"

  echo "--- Flow 1: ticket TI (tipo_ticket presente) ---"
  local BASE1; BASE1="$(max_out_id "$QA")"
  chk "TICKET HTTP" "$(inject_nfm "$QA" '{"tipo_ticket":"credencial_guardada","colaborador":"Marisol","area_sucursal":"Sucursal Centro","detalle":"Su equipo guarda la credencial y ya no pide contrasena","prioridad":"alta","flow_token":"qa-ticket"}' "QA Intake")" "200"
  sleep 7
  local ACK1; ACK1="$(fresh_out_label "$QA" ia360_ticket_intake_ack "$BASE1")"
  echo "  ack: $ACK1"
  chk_has "TICKET eco del tipo elegido"      "$ACK1" "credencial_guardada"
  chk_has "TICKET eco del colaborador"       "$ACK1" "Marisol"
  chk_has "TICKET eco del area"              "$ACK1" "Sucursal Centro"
  chk_has "TICKET eco de la prioridad"       "$ACK1" "prioridad alta"
  chk_has "TICKET eco del detalle escrito"   "$ACK1" "guarda la credencial"
  chk "TICKET persistido en el contacto"     "$(psql_q "SELECT custom_fields->'ia360_ticket_intake_last'->>'tipo_ticket' FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$QA'")" "credencial_guardada"
  chk "TICKET no cayó al fallback genérico"  "$(fresh_count_label "$QA" ia360_interactive_fallback "$BASE1")" "0"

  echo "--- Flow 2: orden de servicio (tipo_entrada presente) ---"
  local BASE2; BASE2="$(max_out_id "$QA")"
  chk "ORDEN HTTP" "$(inject_nfm "$QA" '{"tipo_entrada":"orden_servicio","cliente_nombre":"Ferreteria del Valle","descripcion":"Instalacion de dos equipos en planta baja","evidencia":["fotos","firma"],"flow_token":"qa-orden"}' "QA Intake")" "200"
  sleep 7
  local ACK2; ACK2="$(fresh_out_label "$QA" ia360_orden_intake_ack "$BASE2")"
  echo "  ack: $ACK2"
  chk_has "ORDEN eco del carril elegido"     "$ACK2" "orden_servicio"
  chk_has "ORDEN eco del cliente"            "$ACK2" "Ferreteria del Valle"
  chk_has "ORDEN eco de la evidencia (lista)" "$ACK2" "fotos, firma"
  chk_has "ORDEN eco de la descripcion"      "$ACK2" "dos equipos"
  chk "ORDEN persistida en el contacto"      "$(psql_q "SELECT custom_fields->'ia360_orden_intake_last'->>'tipo_entrada' FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$QA'")" "orden_servicio"
  chk "ORDEN no cayó al fallback genérico"   "$(fresh_count_label "$QA" ia360_interactive_fallback "$BASE2")" "0"

  echo "  labels de la corrida: $(fresh_labels "$QA" "$BASE1")"
  verdict "intake flows ($QA)"
}
# ───────────────────────────────────────────────────────────────────────────
# AUDITORÍA WHATSAPP 2026-08-12 — las correctivas de lo que sí pasó en producción.
#
#   A1 audio de un cliente activo → el bot dice que no puede escucharlo y pide
#      el dato en texto; JAMÁS "te confirmo en breve" (17 veces a Andrés).
#   A2 segunda pregunta con la promesa anterior abierta → reconoce el pendiente
#      sin volver a prometer.
#   A3 "Ok" del owner → silencio (antes: el menú completo, 11 veces en 30 días).
#   A4 alta por vCard → UN mensaje de contexto + readout sin jerga interna
#      ("flywheel", "persona-first") y sin el mensaje suelto de autosuggest.
#   A5 contacto con opener previo → el readout avisa que ya le escribimos.
#   A6 otro agente de código en el mismo hilo → Alekito carga ese contexto.
#   A7 captura con la petición en el pie de foto → nunca "no puedo leer imágenes".
#   A8 nota de voz real → se transcribe y queda en chat_history.media_lectura.
#   A9 tipos huérfanos: location recibe respuesta, system no dispara nada y un
#      documento (xlsx) se lee en local con documentUnderstanding.
cmd_auditoria(){
  local QA="$1" NAME="${2:-Ramiro Auditoria}"; guard_qa "$QA"
  banner "AUDITORÍA — fallback honesto, digest, silencio y readout limpio — $QA" "forgechat_monolith_e2e"
  local BASE_OWNER; BASE_OWNER="$(max_out_id "$OWNER")"

  echo "--- A1: audio de un cliente activo (el sistema lo escucha) ---"
  # El invariante no-silencio sólo vigila clientes activos/beta: se marca el QA
  # como tal para ejercer exactamente la rama que produjo el daño real.
  psql_q "INSERT INTO coexistence.contacts (wa_number, contact_number, name, custom_fields)
          VALUES ('$WA','$QA','$NAME','{\"relationship_context\":\"cliente_activo_beta_supervisado\"}'::jsonb)
          ON CONFLICT (wa_number, contact_number) DO UPDATE
          SET custom_fields = COALESCE(coexistence.contacts.custom_fields,'{}'::jsonb)
                              || '{\"relationship_context\":\"cliente_activo_beta_supervisado\"}'::jsonb" >/dev/null
  psql_q "UPDATE coexistence.ia360_bot_failures SET status='cerrado' WHERE contact_number='$QA' AND status='abierto'" >/dev/null
  local BASE_QA; BASE_QA="$(max_out_id "$QA")"
  local AID; AID="$(wamid audio)"
  chk "A1 audio HTTP" "$(post_webhook "$(_envelope "$QA" "$NAME" "{\"from\":\"$QA\",\"id\":\"$AID\",\"timestamp\":\"$(ts)\",\"type\":\"audio\",\"audio\":{\"id\":\"qa-audio\",\"mime_type\":\"audio/ogg; codecs=opus\"}}")")" "200"
  echo "  esperando 80 s al invariante no-silencio…"
  sleep 80
  local R1; R1="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA ORDER BY id DESC LIMIT 1")"
  echo "  respuesta: ${R1:-(ninguna)}"
  # Un audio ya NO cae al fallback: entra al carril conversacional y lo contesta el
  # agente. Y pase lo que pase con la transcripción de un id de medio sintético, el
  # bot NO puede declararse incapaz de oír: es falso (mediaUnderstanding transcribe).
  chk "A1 el contacto recibió respuesta" "$([ -n "$R1" ] && echo si || echo no)" "si"
  chk_not "A1 NO se declara incapaz de oír" "$R1" "no puedo escuchar"
  chk_not "A1 NO promete confirmación imposible" "$R1" "en breve"

  # A2 mide el copy del FALLBACK, no el del agente: con el agente vivo el contacto
  # recibe una respuesta real y no hay fallback que juzgar. [qa-force-agent-down]
  # simula al agente caído (sólo números QA) — exactamente el escenario de Andrés,
  # donde la promesa se repitió 17 veces porque el agente nunca resolvió. Hacen falta
  # DOS mensajes: el primero crea la promesa, el segundo debe reconocerla sin volver
  # a prometer.
  echo "--- A2: agente caído dos veces seguidas (la promesa no se repite) ---"
  chk "A2 primera pregunta HTTP" "$(inject_text "$QA" "Necesito el reporte de comisiones por sucursal [qa-force-agent-down]" "$NAME")" "200"
  echo "  esperando 80 s (se crea la promesa)…"
  sleep 80
  chk_has "A2 la primera sí promete (una vez)" \
      "$(psql_q "SELECT reason FROM coexistence.ia360_bot_failures WHERE contact_number='$QA' ORDER BY id DESC LIMIT 1")" "texto_primera_promesa"
  local BASE_QA2; BASE_QA2="$(max_out_id "$QA")"
  chk "A2 segunda pregunta HTTP" "$(inject_text "$QA" "Oye y como va lo del reporte de comisiones [qa-force-agent-down]" "$NAME")" "200"
  echo "  esperando 80 s…"
  sleep 80
  local R2; R2="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA2 ORDER BY id DESC LIMIT 1")"
  echo "  respuesta: ${R2:-(ninguna)}"
  chk_has "A2 reconoce el pendiente" "$R2" "pendientes con Alek"
  chk_not "A2 no vuelve a prometer" "$R2" "te confirmo"
  chk_has "A2 el ledger lo marca como promesa repetida" \
      "$(psql_q "SELECT reason FROM coexistence.ia360_bot_failures WHERE contact_number='$QA' ORDER BY id DESC LIMIT 1")" "promesa_repetida_suprimida"

  echo "--- A3: 'Ok' del owner no merece respuesta ---"
  local BASE_OK; BASE_OK="$(max_out_id "$OWNER")"
  chk "A3 Ok HTTP" "$(inject_text "$OWNER" "Ok" "Alek")" "200"
  sleep 8
  chk "A3 cero ruido al owner" \
      "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OK AND template_meta->>'label' IN ('ooa_owner_operator','brainv2_owner_operator_local')")" "0"

  echo "--- A4: el alta llega en un mensaje, sin jerga ---"
  local QB="${QA:0:12}$(( (${QA:12:1} + 3) % 10 ))"
  local BASE_OWNER4; BASE_OWNER4="$(max_out_id "$OWNER")"
  chk "A4 vCard" "$(inject_vcard "$OWNER" "Bruno Aliado BNI" "$QB")" "200"
  sleep 9
  local READ4; READ4="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER4 AND template_meta->>'label' LIKE 'owner_sequence_readout_%' ORDER BY id DESC LIMIT 1")"
  echo "  readout: $(echo "$READ4" | head -3)"
  chk_has "A4 el readout abre diciendo a quién capturó" "$READ4" "Capturé a"
  chk_not "A4 sin encabezado interno"    "$READ4" "Readout IA360 persona-first"
  chk_not "A4 sin jerga de flywheel"     "$READ4" "flywheel"
  chk_not "A4 sin 'Bloqueo actual'"      "$READ4" "Bloqueo actual"
  chk_has "A4 conserva lo que sí decide" "$READ4" "Borrador:"
  chk "A4 ya no sale el aviso suelto de autosuggest" \
      "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER4 AND template_meta->>'label' LIKE 'owner_vcard_autosuggest%'")" "0"

  # OJO: el aviso sólo cuenta openers que SÍ salieron. Un opener 'failed' nunca
  # llegó al contacto, así que no hay narrativa previa que contradecir — por eso
  # el candidato se elige con el mismo filtro que usa producción.
  echo "--- A5: contacto con opener previo → el readout avisa ---"
  local PREV; PREV="$(psql_q "SELECT contact_number FROM coexistence.chat_history WHERE direction='outgoing' AND template_meta->>'label' LIKE 'ia360_seq_opener_%' AND contact_number ~ '^52199900[0-9]{5}\$' AND COALESCE(status,'') NOT IN ('failed','error') AND created_at < NOW() - INTERVAL '1 hour' ORDER BY id DESC LIMIT 1")"
  if [ -z "$PREV" ]; then
    echo "  (sin contacto QA con opener previo: A5 omitido)"
  else
    local BASE_OWNER5; BASE_OWNER5="$(max_out_id "$OWNER")"
    chk "A5 vCard del contacto con historia" "$(inject_vcard "$OWNER" "Contacto Con Historia" "$PREV")" "200"
    sleep 9
    local READ5; READ5="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND id>$BASE_OWNER5 AND template_meta->>'label' LIKE 'owner_sequence_readout_%' ORDER BY id DESC LIMIT 1")"
    echo "  aviso: $(echo "$READ5" | grep -i 'ya le escribimos' || echo '(ninguno)')"
    chk_has "A5 el owner sabe que ya le escribimos" "$READ5" "ya le escribimos antes"
  fi

  # A6 — HILO COMPARTIDO (12-ago-2026). Otros agentes de código ya le escriben a
  # los mismos usuarios por este WhatsApp. Se simula un saliente SIN label (así se
  # ven los de otros agentes en chat_history), el contacto contesta a ESO, y se
  # comprueba que Alekito cargó el contexto en vez de creer que hablaba solo.
  echo "--- A6: otro agente en el hilo → Alekito se entera ---"
  psql_q "INSERT INTO coexistence.chat_history
            (message_id, wa_number, contact_number, direction, message_type, message_body, status, timestamp, template_meta)
          VALUES ('wamid.otroagente.$RANDOM.$(ts)','$WA','$QA','outgoing','text',
                  'Ya quedó arriba el panel que pediste; dime si te sirve así.','sent',NOW(), NULL)" >/dev/null
  # (ventana relativa: `--since` con timestamp absoluto lo interpreta docker en su
  # propia zona y se comía la traza aunque estuviera en el log)
  chk "A6 el contacto responde a ese mensaje" "$(inject_text "$QA" "sí me sirve, pero el total no cuadra con lo que veo en el ERP" "$NAME")" "200"
  sleep 12
  local TRAZA; TRAZA="$(docker logs "$BE" --since 60s 2>&1 | grep -c 'ia360-thread. hilo compartido' || true)"
  chk_has "A6 Alekito detecta que el hilo lo atiende otro agente" "traza=$TRAZA" "traza=1"

  # A7 — CAPTURA CON PIE DE FOTO (incidente Andrés, 12-ago 17:41). Mandó una imagen
  # con toda su petición escrita en el pie y el bot le contestó «no puedo leer
  # imágenes: cuéntame en una línea qué necesitas» — pedirle que repitiera lo que
  # acababa de escribir era literalmente su queja. Se reproduce su mensaje real.
  echo "--- A7: captura con petición en el pie de foto ---"
  local BASE_QA7; BASE_QA7="$(max_out_id "$QA")"
  local CAP="quedo bien el Mapa ejecutivo de sistemas, me gustaria ver cual fue la ultima fecha de actualizacion y si ha presentado errores, he intentado cargar el plan piso desde el 22 de julio y me señala un error"
  chk "A7 imagen con pie de foto HTTP" \
      "$(post_webhook "$(_envelope "$QA" "$NAME" "{\"from\":\"$QA\",\"id\":\"$(wamid img)\",\"timestamp\":\"$(ts)\",\"type\":\"image\",\"image\":{\"id\":\"qa-img\",\"mime_type\":\"image/jpeg\",\"caption\":\"$CAP\"}}")")" "200"
  echo "  esperando 85 s (agente + red de seguridad del invariante)…"
  sleep 85
  local R7; R7="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA7 ORDER BY id DESC LIMIT 1")"
  echo "  respuesta: ${R7:-(ninguna)}"
  chk_not "A7 NO le pide repetir lo que ya escribió" "$R7" "en una línea"
  chk_not "A7 NO dice que no puede leer imágenes"    "$R7" "Aún no puedo leer imágenes"
  chk "A7 el contacto sí recibió respuesta"          "$([ -n "$R7" ] && echo si || echo no)" "si"

  # A8 — EL SISTEMA SÍ OYE Y SÍ VE (Alek, 12-ago). Decir «no puedo escuchar audios»
  # era falso: la capacidad vive en n8n (visión + transcripción) y este servicio la
  # cablea. Se ejerce el CAMINO REAL (mediaUnderstanding → n8n → columna
  # media_lectura) sobre una nota de voz que un champion mandó de verdad y que nadie
  # escuchó nunca. No se puede probar inyectando un webhook sintético: el id de medio
  # falso no existe en Meta, el downloader marca la fila 'failed' y el inbound
  # repetido se deduplica — se probaría el harness, no el sistema.
  echo "--- A8: nota de voz real → el sistema la escucha ---"
  local FILA8; FILA8="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='incoming' AND message_type IN ('audio','voice') AND media_status='stored' AND media_lectura IS NULL ORDER BY id DESC LIMIT 1")"
  if [ -z "$FILA8" ]; then
    echo "  (no hay notas de voz almacenadas sin leer: A8 omitido)"
  else
    local OUT8; OUT8="$(docker exec "$BE" node -e "
      const pool=require('/app/src/db');
      const {leerMedio}=require('/app/src/services/mediaUnderstanding');
      (async()=>{
        const {rows}=await pool.query(\"SELECT message_id, message_type, media_mime_type FROM coexistence.chat_history WHERE message_id=\\\$1\",['$FILA8']);
        const r=await leerMedio({record:rows[0],contexto:'Champion de Camiones Selectos escribiendo a Alek'});
        console.log(JSON.stringify({ok:r.ok,motivo:r.motivo||null,chars:(r.texto||'').length}));
        process.exit(0);})();" 2>/dev/null | tail -1)"
    echo "  lectura: $OUT8"
    chk_has "A8 el audio se transcribió" "$OUT8" '"ok":true'
    local GUARDADO; GUARDADO="$(psql_q "SELECT COALESCE(length(media_lectura),0) FROM coexistence.chat_history WHERE message_id='$FILA8'")"
    chk "A8 la transcripción quedó guardada en la fila" "$([ "${GUARDADO:-0}" -gt 30 ] && echo si || echo no)" "si"
    echo "  transcrito: $(psql_q "SELECT left(regexp_replace(media_lectura,'\s+',' ','g'),150) FROM coexistence.chat_history WHERE message_id='$FILA8'")"
  fi

  # A9 — NINGÚN TIPO CON CONTENIDO QUEDA HUÉRFANO (12-ago-2026). El inventario por
  # tipo de mensaje dejó ver tres huecos: `location` llegaba con su texto crudo y
  # nadie lo atendía; `system`/`unknown` no son una petición pero SÍ disparaban el
  # watchdog de no-silencio (contestarle a un aviso de plataforma es responderle a
  # nadie); y `document` sólo guardaba el nombre del archivo.
  echo "--- A9: tipos huérfanos (location, system, document) ---"

  local BASE_QA9; BASE_QA9="$(max_out_id "$QA")"
  chk "A9 ubicación HTTP" \
      "$(post_webhook "$(_envelope "$QA" "$NAME" "{\"from\":\"$QA\",\"id\":\"$(wamid loc)\",\"timestamp\":\"$(ts)\",\"type\":\"location\",\"location\":{\"latitude\":20.67,\"longitude\":-103.35}}")")" "200"
  echo "  esperando 85 s (agente + red de seguridad del invariante)…"
  sleep 85
  local R9; R9="$(psql_q "SELECT message_body FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$QA' AND id>$BASE_QA9 ORDER BY id DESC LIMIT 1")"
  echo "  respuesta a la ubicación: ${R9:-(ninguna)}"
  chk     "A9 la ubicación sí recibió respuesta" "$([ -n "$R9" ] && echo si || echo no)" "si"
  chk_not "A9 no contesta que no puede leerlo"   "$R9" "no puedo"

  # system: cero salientes. El watchdog ya no debe dispararlo.
  local BASE_SYS; BASE_SYS="$(max_out_id "$QA")"
  chk "A9 system HTTP" \
      "$(post_webhook "$(_envelope "$QA" "$NAME" "{\"from\":\"$QA\",\"id\":\"$(wamid sys)\",\"timestamp\":\"$(ts)\",\"type\":\"system\",\"system\":{\"body\":\"El número cambió\"}}")")" "200"
  echo "  esperando 85 s (ventana completa del watchdog)…"
  sleep 85
  chk "A9 un aviso de plataforma NO genera salientes" "$(max_out_id "$QA")" "$BASE_SYS"

  # document: se ejerce el camino real (documentUnderstanding parsea en local) sobre
  # un xlsx que un contacto mandó de verdad. Igual que A8, no se inyecta por webhook:
  # un id de medio sintético no existe en Meta, el downloader marcaría la fila
  # 'failed' y se probaría el harness, no el sistema.
  local FILA9; FILA9="$(psql_q "SELECT message_id FROM coexistence.chat_history WHERE direction='incoming' AND message_type='document' AND media_status='stored' AND media_mime_type LIKE '%spreadsheet%' ORDER BY id DESC LIMIT 1")"
  if [ -z "$FILA9" ]; then
    echo "  (no hay hojas de cálculo almacenadas: A9-documento omitido)"
  else
    local OUT9; OUT9="$(docker exec "$BE" node -e "
      const pool=require('/app/src/db');
      const {leerDocumento}=require('/app/src/services/documentUnderstanding');
      (async()=>{
        const {rows}=await pool.query(\"SELECT message_id, message_type, media_mime_type, media_size_bytes FROM coexistence.chat_history WHERE message_id=\\\$1\",['$FILA9']);
        const r=await leerDocumento({record:rows[0]});
        console.log(JSON.stringify({ok:r.ok,motivo:r.motivo||null,chars:(r.texto||'').length,hoja:/^Hoja «/.test(r.texto||'')}));
        process.exit(0);})();" 2>/dev/null | tail -1)"
    echo "  lectura del documento: $OUT9"
    chk_has "A9 la hoja de cálculo se leyó"        "$OUT9" '"ok":true'
    chk_has "A9 el resumen empieza por la hoja"    "$OUT9" '"hoja":true'
    local GUARDADO9; GUARDADO9="$(psql_q "SELECT COALESCE(length(media_lectura),0) FROM coexistence.chat_history WHERE message_id='$FILA9'")"
    chk "A9 la lectura quedó guardada en la fila" "$([ "${GUARDADO9:-0}" -gt 50 ] && echo si || echo no)" "si"
  fi

  echo "  labels de la corrida al owner: $(fresh_labels "$OWNER" "$BASE_OWNER")"
  verdict "auditoria ($QA)"
}

# ───────────────────────────────────────────────────────────────────────────
# TRIAJE DE DESCONOCIDOS (12-ago-2026). Quien escribe sin estar en ningún embudo
# ya no queda mudo: se le ubica, se le contesta UNA pregunta y el caso queda
# anotado. Lo que se prueba aquí es la política completa, incluido lo que NO debe
# pasar (no conversar sin fin, no interrumpir a Alek por difusión).
#
#   D1 saludo de un desconocido        → sondeo + caso anotado, sin tarjeta
#   D2 dice a qué viene (cliente)      → respuesta + tarjeta al owner
#   D3 sigue escribiendo               → tope de mensajes automáticos: silencio
#   D4 difusión/promoción              → un cierre honesto, cero tarjeta, silenciado
#   D5 "gracias" de un desconocido     → cero respuesta (no es una petición)
cmd_desconocidos(){
  local QA="$1"; guard_qa "$QA"
  local QA2=$((QA + 1)); guard_qa "$QA2"
  local QA3=$((QA + 2)); guard_qa "$QA3"
  banner "TRIAJE DE DESCONOCIDOS — sondeo, ruteo y silencio donde toca — $QA" "forgechat_monolith_e2e"

  echo "--- D0: los tres QA arrancan como perfectos desconocidos ---"
  for N in "$QA" "$QA2" "$QA3"; do
    psql_q "DELETE FROM coexistence.deals WHERE contact_number='$N'" >/dev/null
    psql_q "UPDATE coexistence.contacts SET custom_fields = COALESCE(custom_fields,'{}'::jsonb) - 'ia360_triaje' - 'ia360_cliente_activo_beta' - 'lifecycle_stage' - 'relationship_context' - 'ia360_revenue_state', tags='{}' WHERE wa_number='$WA' AND contact_number='$N'" >/dev/null
    psql_q "DELETE FROM coexistence.ia360_bot_failures WHERE contact_number='$N'" >/dev/null
    # Las tarjetas al owner llevan el número en el label: se cuentan por persona,
    # no por ventana de tiempo (una corrida anterior falseaba el conteo).
    psql_q "DELETE FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_desconocido_triaje_$N'" >/dev/null
  done
  ok "estado de triaje limpio en $QA, $QA2 y $QA3"

  echo "--- D1: un desconocido saluda ---"
  local BASE1; BASE1="$(max_out_id "$QA")"
  chk "D1 saludo HTTP" "$(inject_text "$QA" "Buenos dias amigo como estas? Un gusto en saludarte, mi nombre es Manuel" "Manuel Prospecto")" "200"
  sleep 15
  local R1; R1="$(fresh_out_label "$QA" "ia360_triaje_indeterminado" "$BASE1")"
  echo "  sondeo: ${R1:-(ninguno)}"
  chk     "D1 el desconocido SÍ recibió respuesta" "$([ -n "$R1" ] && echo si || echo no)" "si"
  chk_has "D1 se presenta como Alekito"            "$R1" "Alekito, el asistente de Alek"
  chk_has "D1 pregunta de qué se trata"            "$R1" "de qué se trata"
  chk     "D1 el caso quedó anotado" \
          "$(psql_q "SELECT count(*) FROM coexistence.ia360_bot_failures WHERE contact_number='$QA' AND reason LIKE 'desconocido:indeterminado%' AND status='abierto'")" "1"
  chk     "D1 estado de triaje = sondeado" \
          "$(psql_q "SELECT custom_fields->'ia360_triaje'->>'estado' FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$QA'")" "sondeado"
  chk     "D1 un saludo NO interrumpe a Alek" \
          "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_desconocido_triaje_$QA'")" "0"

  echo "--- D2: dice a qué viene y resulta cliente potencial ---"
  local BASE2; BASE2="$(max_out_id "$QA")"
  chk "D2 segundo mensaje HTTP" "$(inject_text "$QA" "necesito automatizar el seguimiento de mis clientes por WhatsApp" "Manuel Prospecto")" "200"
  sleep 15
  local R2; R2="$(fresh_out_label "$QA" "ia360_triaje_cliente_potencial" "$BASE2")"
  echo "  respuesta: ${R2:-(ninguna)}"
  chk     "D2 respondió como cliente potencial" "$([ -n "$R2" ] && echo si || echo no)" "si"
  chk_not "D2 ya no se vuelve a presentar"      "$R2" "Soy Alekito"
  chk     "D2 esta vez SÍ hay tarjeta para Alek" \
          "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_desconocido_triaje_$QA'")" "1"
  chk     "D2 la tarjeta NO egresó al WhatsApp real (origen sintético)" \
          "$(psql_q "SELECT status FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_desconocido_triaje_$QA' ORDER BY id DESC LIMIT 1")" "qa_sandboxed"
  chk     "D2 estado de triaje = escalado" \
          "$(psql_q "SELECT custom_fields->'ia360_triaje'->>'estado' FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$QA'")" "escalado"

  echo "--- D3: el tope de mensajes automáticos ---"
  chk "D3 tercer mensaje HTTP" "$(inject_text "$QA" "sobre todo la parte de cobranza" "Manuel Prospecto")" "200"
  sleep 15
  local BASE4; BASE4="$(max_out_id "$QA")"
  chk "D3 cuarto mensaje HTTP" "$(inject_text "$QA" "y también el reporte mensual" "Manuel Prospecto")" "200"
  sleep 15
  chk "D3 al cuarto mensaje el bot ya no contesta" "$(max_out_id "$QA")" "$BASE4"
  chk "D3 el caso queda cerrado para el bot" \
      "$(psql_q "SELECT custom_fields->'ia360_triaje'->>'estado' FROM coexistence.contacts WHERE wa_number='$WA' AND contact_number='$QA'")" "cerrado"
  # Un caso por persona, no uno por mensaje: cuatro mensajes suyos = una sola fila
  # en el ledger y una sola tarjeta. Es lo que evita repetir el ruido de las 17
  # promesas idénticas que recibió Andrés.
  chk "D3 sigue habiendo UN solo caso abierto de esa persona" \
      "$(psql_q "SELECT count(*) FROM coexistence.ia360_bot_failures WHERE contact_number='$QA'")" "1"
  chk "D3 y UNA sola tarjeta para Alek" \
      "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_desconocido_triaje_$QA'")" "1"
  chk "D3 el caso acumuló lo que fue diciendo" \
      "$(psql_q "SELECT CASE WHEN contact_message LIKE '%cobranza%' THEN 'si' ELSE 'no' END FROM coexistence.ia360_bot_failures WHERE contact_number='$QA' ORDER BY id DESC LIMIT 1")" "si"

  echo "--- D4: difusión/promoción ---"
  local BASE5; BASE5="$(max_out_id "$QA2")"
  chk "D4 promoción HTTP" "$(inject_text "$QA2" "PROMOCION: ultimos lugares, inscribete al webinar de IA, cupos limitados" "Promotor QA")" "200"
  sleep 15
  local R4; R4="$(fresh_out_label "$QA2" "ia360_triaje_marketing_masivo" "$BASE5")"
  echo "  cierre: ${R4:-(ninguno)}"
  chk     "D4 se le contesta una vez, con honestidad" "$([ -n "$R4" ] && echo si || echo no)" "si"
  chk_has "D4 dice que no es lo que se busca"         "$R4" "no es algo que estemos buscando"
  chk     "D4 la difusión NO interrumpe a Alek" \
          "$(psql_q "SELECT count(*) FROM coexistence.chat_history WHERE direction='outgoing' AND contact_number='$OWNER' AND template_meta->>'label'='owner_desconocido_triaje_$QA2'")" "0"
  chk     "D4 el caso nace cerrado (no es un pendiente)" \
          "$(psql_q "SELECT status FROM coexistence.ia360_bot_failures WHERE contact_number='$QA2' ORDER BY id DESC LIMIT 1")" "ignorado"
  local BASE6; BASE6="$(max_out_id "$QA2")"
  chk "D4 insiste HTTP" "$(inject_text "$QA2" "te comparto el temario, son 8 horas de capacitacion" "Promotor QA")" "200"
  sleep 15
  chk "D4 al insistir ya no se le contesta" "$(max_out_id "$QA2")" "$BASE6"

  echo "--- D5: un 'gracias' suelto no es una petición ---"
  local BASE7; BASE7="$(max_out_id "$QA3")"
  chk "D5 gracias HTTP" "$(inject_text "$QA3" "gracias" "Ana QA")" "200"
  sleep 15
  chk "D5 cero respuesta a un pasivo de desconocido" "$(max_out_id "$QA3")" "$BASE7"
  chk "D5 y tampoco se le abrió un caso" \
      "$(psql_q "SELECT count(*) FROM coexistence.ia360_bot_failures WHERE contact_number='$QA3'")" "0"

  verdict "desconocidos ($QA)"
}


# ───────────────────────────────────────────────────────────────────────────
case "${1:-help}" in
  revenue-os)     cmd_revenue_os "${2:?num_qa}";;
  gate-slots-bug) cmd_gate_slots_bug "${2:?num_qa}";;
  hijack)         cmd_hijack "${2:?num_qa}";;
  entrega)        cmd_entrega "${2:?num_qa}";;
  intake)         cmd_intake "${2:?num_qa}";;
  m100)           cmd_m100 "${2:?num_qa}";;
  seq)            cmd_seq "${2:?num_qa}" "${3:?seq_id}" "${4:?opcion}" "${5:?titulo}";;
  cold-send)      cmd_cold_send "${2:?num_qa}" "${3:?persona}" "${4:?seq_id}" "${5:-}";;
  diapazo-alta)   cmd_diapazo_alta "${2:?num_qa}" "${3:-}";;
  expansion-deal) cmd_expansion_deal "${2:?num_qa}" "${3:-}";;
  desenlaces)     cmd_desenlaces "${2:?num_qa}" "${3:-}";;
  auditoria)      cmd_auditoria "${2:?num_qa}" "${3:-}";;
  desconocidos)   cmd_desconocidos "${2:?num_qa}";;
  alta-matrix)    cmd_alta_matrix "matrix" "${2:-}";;
  template-only)  cmd_template_only "${2:?num_qa}" "${3:?template_name}" "${4:?pipeline}" "${5:-}";;
  *) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
esac
