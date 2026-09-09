#!/usr/bin/env python3
"""
test_candidate_harness.py — Test Harness aislado para Code Nodes de candidatos IA360 / Agenda.
Prueba la lógica de transformación JS y contratos de payload bajo Node.js contra fixtures sintéticos.
NOTA DE ALCANCE: Valida la lógica de Code Nodes en aislamiento. No evalúa el DAG completo del broker n8n ni base de datos real.
"""

import json
import os
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INFRA_DIR = os.path.dirname(SCRIPT_DIR)
CANDIDATES_DIR = os.path.join(INFRA_DIR, "candidates")

def run_node_js(js_code, input_items, env_vars=None, mock_nodes=None):
    """
    Ejecuta un snippet de código n8n Code Node dentro de Node.js con mocks de $input, $env y $().
    Lanza Error('Node "..." has no execution data or was not executed') si se accede a un nodo
    no provisto en mock_nodes, emulando fielmente el comportamiento de n8n en runtime.
    """
    mock_nodes_json = json.dumps(mock_nodes or {})
    runner_script = f"""
const $env = {json.dumps(env_vars or {})};
const $input = {{
  first: () => ({json.dumps(input_items[0] if input_items else {})}),
  all: () => ({json.dumps(input_items)})
}};
const __mockNodes = {mock_nodes_json};
function $(nodeName) {{
  if (!Object.prototype.hasOwnProperty.call(__mockNodes, nodeName)) {{
    throw new Error(`Node "${{nodeName}}" has no execution data or was not executed`);
  }}
  const nData = __mockNodes[nodeName];
  return {{
    first: () => (nData),
    item: (nData),
    all: () => ([nData])
  }};
}}

try {{
  const run = () => {{
    {js_code}
  }};
  const result = run();
  console.log(JSON.stringify({{ success: true, result }}));
}} catch (err) {{
  console.log(JSON.stringify({{ success: false, error: err.message || String(err) }}));
}}
"""
    cmd = ["node", "-e", runner_script]
    raw = subprocess.check_output(cmd).decode("utf-8").strip()
    return json.loads(raw)

def test_harness():
    print("=================================================================")
    print(" Candidate Workflows JS Code Nodes Test Harness (Isolated JS Code Nodes & Contract Logic Only)")
    print("=================================================================")

    # -------------------------------------------------------------------------
    # 1. TEST sjrkjf7IcM7ski0n (Wrapper Reservar)
    # -------------------------------------------------------------------------
    res_wf = json.load(open(os.path.join(CANDIDATES_DIR, "sjrkjf7IcM7ski0n.candidate.json")))
    nodes_res = {n["name"]: n for n in res_wf["nodes"]}

    # 1A. Preparar Propuesta Reserva con resources canonical
    code_prep_prop = nodes_res["Preparar Propuesta Reserva"]["parameters"]["jsCode"]
    res_prop = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-25T16:00:00Z",
        "fin_iso": "2026-08-25T17:00:00Z",
        "numero_contacto": "5213321594582",
        "nombre_contacto": "Contacto Sintético Test",
        "wa_number": "5213321060293",
        "source_message_id": "msg-test-123",
        "resources": ["calendar", "zoom"],
        "dry_run": True
    }}])
    assert res_prop["success"] is True, f"Failed: {res_prop}"
    p_prop = res_prop["result"][0]["json"]
    assert p_prop["kind"] == "book"
    assert p_prop["resources"] == ["calendar", "zoom"]
    assert p_prop["contact_number"] == "5213321594582"
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Payload con resources ['calendar', 'zoom'].")

    # 1B. Preparar Propuesta Reserva rechaza resources inválido/vacío
    res_prop_invalid = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-25T16:00:00Z",
        "fin_iso": "2026-08-25T17:00:00Z",
        "numero_contacto": "5213321594582",
        "resources": []
    }}])
    assert res_prop_invalid["success"] is False and "RECURSOS_INVALIDOS" in res_prop_invalid["error"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Rechaza resources vacío.")

    # 1C. Preparar Reserva: Auth y Confirmación Owner
    code_prep_res = nodes_res["Preparar Reserva"]["parameters"]["jsCode"]
    res_no_auth = run_node_js(code_prep_res, [{"json": {
        "headers": {},
        "body": {"confirmado_por_owner": "true", "resources": ["calendar"], "inicio_iso": "2026-08-25T16:00:00Z", "fin_iso": "2026-08-25T17:00:00Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_token_123"})
    assert res_no_auth["success"] is False and "AUTH_FAILED" in res_no_auth["error"]

    res_no_conf = run_node_js(code_prep_res, [{"json": {
        "headers": {"authorization": "Bearer secret_token_123"},
        "body": {"confirmado_por_owner": "false", "resources": ["calendar"], "inicio_iso": "2026-08-25T16:00:00Z", "fin_iso": "2026-08-25T17:00:00Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_token_123"})
    assert res_no_conf["success"] is False and "CONFIRMACION_REQUERIDA" in res_no_conf["error"]

    res_valid_res = run_node_js(code_prep_res, [{"json": {
        "headers": {"authorization": "Bearer secret_token_123"},
        "body": {
            "confirmado_por_owner": "true",
            "resources": ["zoom"],
            "inicio_iso": "2026-08-25T16:00:00Z",
            "fin_iso": "2026-08-25T17:00:00Z",
            "numero_contacto": "5213321594582",
            "operation_id": "op-zoom-1"
        }
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_token_123"})
    assert res_valid_res["success"] is True
    assert res_valid_res["result"][0]["json"]["resources"] == ["zoom"]
    assert len(res_valid_res["result"][0]["json"]["token"]) == 20
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Reserva: Auth + confirmación + token de 20 caracteres.")

    # 1D. Responder Propuesta: Estado dry_run sin proposal_id y sin tap del owner
    code_resp_prop = nodes_res["Responder Propuesta"]["parameters"]["jsCode"]
    res_prop_dry = run_node_js(code_resp_prop, [{"json": {
        "ok": True,
        "state": "dry_run",
        "proposal_id": None
    }}], mock_nodes={
        "Preparar Propuesta Reserva": {"json": {
            "resources": ["calendar", "zoom"],
            "start_utc": "2026-08-25 16:00:00+00",
            "end_utc": "2026-08-25 17:00:00+00",
            "title": "Propuesta Test Dry Run"
        }}
    })
    assert res_prop_dry["success"] is True
    out_prop_dry = res_prop_dry["result"][0]["json"]
    assert out_prop_dry["ok"] is True
    assert out_prop_dry["estado"] == "dry_run"
    assert out_prop_dry["state"] == "dry_run"
    assert out_prop_dry["proposal_id"] is None
    assert out_prop_dry["requires_owner_tap"] is False
    print("  [PASS] sjrkjf7IcM7ski0n -> Responder Propuesta: dry_run maneja proposal_id:null y requires_owner_tap:false.")

    # 1E. Responder Propuesta: Propuesta regular pending_owner_confirmation
    res_prop_reg = run_node_js(code_resp_prop, [{"json": {
        "ok": True,
        "proposal_id": "prop-res-123",
        "state": "pending_owner_confirmation"
    }}], mock_nodes={
        "Preparar Propuesta Reserva": {"json": {
            "resources": ["calendar", "zoom"],
            "start_utc": "2026-08-25 16:00:00+00",
            "end_utc": "2026-08-25 17:00:00+00",
            "title": "Propuesta Real"
        }}
    })
    assert res_prop_reg["success"] is True
    out_prop_reg = res_prop_reg["result"][0]["json"]
    assert out_prop_reg["ok"] is True
    assert out_prop_reg["estado"] == "propuesta_creada"
    assert out_prop_reg["proposal_id"] == "prop-res-123"
    assert out_prop_reg["requires_owner_tap"] is True
    print("  [PASS] sjrkjf7IcM7ski0n -> Responder Propuesta: Regular pending_owner_confirmation con proposal_id.")

    # 1F. Responder Reserva: Formato de salida con components y estado durable
    code_resp_res = nodes_res["Responder Reserva"]["parameters"]["jsCode"]
    res_resp_ok = run_node_js(code_resp_res, [{"json": {
        "token": "tok_12345678901234567890",
        "event_id": "ev-123"
    }}], mock_nodes={
        "Preparar Reserva": {"json": {
            "token": "tok_12345678901234567890",
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Sesión Estratégica"
        }},
        "Reservar Calendar y Zoom": {"json": {
            "ok": True,
            "verified": True,
            "components": {
                "calendar": {"state": "verified", "id": "ev-123"},
                "zoom": {"state": "verified", "id": "zm-456", "join_url": "https://zoom.us/j/456"}
            }
        }}
    })
    assert res_resp_ok["success"] is True
    out_resp = res_resp_ok["result"][0]["json"]
    assert out_resp["verified"] is True
    assert out_resp["state"] == "agendada"
    assert out_resp["components"]["calendar"]["state"] == "verified"
    assert out_resp["components"]["zoom"]["state"] == "verified"
    print("  [PASS] sjrkjf7IcM7ski0n -> Responder Reserva: Componentes verificados y estado 'agendada'.")

    # 1G. Responder Fallo: Formato de fallo normalizado
    code_resp_fallo = nodes_res["Responder Fallo"]["parameters"]["jsCode"]
    res_resp_fallo = run_node_js(code_resp_fallo, [{"json": {
        "error": "Reserva rechazada por timeout de proveedor"
    }}], mock_nodes={
        "Preparar Reserva": {"json": {
            "resources": ["calendar", "zoom"]
        }}
    })
    assert res_resp_fallo["success"] is True
    out_fallo = res_resp_fallo["result"][0]["json"]
    assert out_fallo["ok"] is False
    assert out_fallo["verified"] is False
    assert out_fallo["state"] == "no_agendada"
    assert out_fallo["resources"] == ["calendar", "zoom"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Responder Fallo: Formato de fallo ok:false, verified:false.")

    # 1H. Preparar Propuesta Reserva: Validación determinista de horario laboral con precisión de milisegundos
    # Límite inferior exacto 08:00:00.000 local MX (14:00:00.000Z) -> PASS
    res_prop_start_exact = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-25T14:00:00.000Z",
        "fin_iso": "2026-08-25T15:00:00.000Z",
        "numero_contacto": "5213321594582",
        "resources": ["calendar"]
    }}])
    assert res_prop_start_exact["success"] is True
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Límite exacto 08:00:00.000 local MX aceptado.")

    # Límite superior exacto 20:00:00.000 local MX (fin 02:00:00.000Z día siguiente) -> PASS
    res_prop_end_exact = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-26T01:00:00.000Z",
        "fin_iso": "2026-08-26T02:00:00.000Z",
        "numero_contacto": "5213321594582",
        "resources": ["zoom"]
    }}])
    assert res_prop_end_exact["success"] is True
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Límite exacto 20:00:00.000 local MX aceptado.")

    # Negativo: +1ms sobre 20:00 (20:00:00.001 local MX = 02:00:00.001Z) -> MUST FAIL con AGENDA_OUTSIDE_BUSINESS_HOURS
    res_prop_end_plus_1ms = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-26T01:00:00.000Z",
        "fin_iso": "2026-08-26T02:00:00.001Z",
        "numero_contacto": "5213321594582",
        "resources": ["zoom"]
    }}])
    assert res_prop_end_plus_1ms["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_prop_end_plus_1ms["error"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Rechaza 20:00:00.001 (+1ms) con AGENDA_OUTSIDE_BUSINESS_HOURS.")

    # Negativo: -1ms antes de 08:00 (07:59:59.999 local MX = 13:59:59.999Z) -> MUST FAIL con AGENDA_OUTSIDE_BUSINESS_HOURS
    res_prop_start_minus_1ms = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-25T13:59:59.999Z",
        "fin_iso": "2026-08-25T15:00:00.000Z",
        "numero_contacto": "5213321594582",
        "resources": ["calendar"]
    }}])
    assert res_prop_start_minus_1ms["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_prop_start_minus_1ms["error"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Rechaza 07:59:59.999 (-1ms) con AGENDA_OUTSIDE_BUSINESS_HOURS.")

    # Negativo: Cruce de día local (19:00 MX a 09:00 MX día siguiente)
    res_prop_cross = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-26T01:00:00Z",
        "fin_iso": "2026-08-26T15:00:00Z",
        "numero_contacto": "5213321594582",
        "resources": ["calendar", "zoom"]
    }}])
    assert res_prop_cross["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_prop_cross["error"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Rechaza evento con cruce de día local (AGENDA_OUTSIDE_BUSINESS_HOURS).")

    # 1I. Preparar Reserva: Revalidación determinista al confirmar propuestas (sin evasión por confirmación owner)
    res_res_outside = run_node_js(code_prep_res, [{"json": {
        "headers": {"authorization": "Bearer secret_token_123"},
        "body": {
            "confirmado_por_owner": "true",
            "resources": ["calendar"],
            "inicio_iso": "2026-08-25T05:00:00Z",  # 23:00 local día anterior (fuera de horario)
            "fin_iso": "2026-08-25T06:00:00Z",
            "numero_contacto": "5213321594582"
        }
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_token_123"})
    assert res_res_outside["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_res_outside["error"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Reserva: Revalidación rechaza horario fuera de 08:00–20:00 aún con confirmado_por_owner:true.")

    # -------------------------------------------------------------------------
    # 2. TEST F1sj5tcJVa9R3Q9Z (Wrapper Cancelar)
    # -------------------------------------------------------------------------
    can_wf = json.load(open(os.path.join(CANDIDATES_DIR, "F1sj5tcJVa9R3Q9Z.candidate.json")))
    nodes_can = {n["name"]: n for n in can_wf["nodes"]}

    # 2A. Preparar Propuesta Cancelacion: Zoom-only exige zoom_id, no calendar
    code_prep_can = nodes_can["Preparar Propuesta Cancelacion"]["parameters"]["jsCode"]
    res_can_zoom = run_node_js(code_prep_can, [{"json": {
        "resources": ["zoom"],
        "zoom_id": "zm-999",
        "numero_contacto": "5213321594582"
    }}])
    assert res_can_zoom["success"] is True
    assert res_can_zoom["result"][0]["json"]["zoom_id"] == "zm-999"
    assert res_can_zoom["result"][0]["json"]["event_id"] is None
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Preparar Propuesta Cancelacion: Cancelación Zoom-only no exige evento_id.")

    # 2B. Preparar Propuesta Cancelacion: Calendar-only sin evento_id falla
    res_can_cal_err = run_node_js(code_prep_can, [{"json": {
        "resources": ["calendar"],
        "numero_contacto": "5213321594582"
    }}])
    assert res_can_cal_err["success"] is False and "FALTA_EVENTO" in res_can_cal_err["error"]
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Preparar Propuesta Cancelacion: Calendar-only sin evento_id lanza error.")

    # 2C. Responder Propuesta Cancelacion: dry_run sin proposal_id y sin tap
    code_resp_prop_can = nodes_can["Responder Propuesta Cancelacion"]["parameters"]["jsCode"]
    res_prop_can_dry = run_node_js(code_resp_prop_can, [{"json": {
        "ok": True,
        "state": "dry_run",
        "proposal_id": None
    }}], mock_nodes={
        "Preparar Propuesta Cancelacion": {"json": {
            "resources": ["calendar"],
            "event_id": "ev-123",
            "zoom_id": None
        }}
    })
    assert res_prop_can_dry["success"] is True
    out_prop_can_dry = res_prop_can_dry["result"][0]["json"]
    assert out_prop_can_dry["ok"] is True
    assert out_prop_can_dry["estado"] == "dry_run"
    assert out_prop_can_dry["state"] == "dry_run"
    assert out_prop_can_dry["proposal_id"] is None
    assert out_prop_can_dry["requires_owner_tap"] is False
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Responder Propuesta Cancelacion: dry_run maneja proposal_id:null y requires_owner_tap:false.")

    # 2D. Responder Propuesta Cancelacion: Propuesta regular pending_owner_confirmation
    res_prop_can_reg = run_node_js(code_resp_prop_can, [{"json": {
        "ok": True,
        "proposal_id": "prop-can-456",
        "state": "pending_owner_confirmation"
    }}], mock_nodes={
        "Preparar Propuesta Cancelacion": {"json": {
            "resources": ["zoom"],
            "event_id": None,
            "zoom_id": "zm-456"
        }}
    })
    assert res_prop_can_reg["success"] is True
    out_prop_can_reg = res_prop_can_reg["result"][0]["json"]
    assert out_prop_can_reg["ok"] is True
    assert out_prop_can_reg["estado"] == "propuesta_cancelacion_creada"
    assert out_prop_can_reg["proposal_id"] == "prop-can-456"
    assert out_prop_can_reg["requires_owner_tap"] is True
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Responder Propuesta Cancelacion: Regular pending_owner_confirmation con proposal_id.")

    # 2E. Responder Cancelacion: Cancelación selectiva de Calendar en cita dual (preserva Zoom y token)
    code_resp_can = nodes_can["Responder Cancelacion"]["parameters"]["jsCode"]
    res_resp_can_dual = run_node_js(code_resp_can, [{"json": {
        "token": "tok_dual_123",
        "event_id": None,
        "zoom_meeting_id": 987654321,
        "op": "updated"
    }}], mock_nodes={
        "Preparar Cancelacion": {"json": {
            "resources": ["calendar"],
            "calendarEventId": "ev-123"
        }},
        "Cancelar Calendar y Zoom": {"json": {
            "ok": True,
            "verified": True,
            "components": {
                "calendar": {"state": "verified", "id": "ev-123"}
            }
        }}
    })
    assert res_resp_can_dual["success"] is True
    out_can_dual = res_resp_can_dual["result"][0]["json"]
    assert out_can_dual["verified"] is True
    assert out_can_dual["state"] == "cancelada"
    assert out_can_dual["enlace_actualizado"] is True
    assert out_can_dual["enlace_retirado"] is False
    assert out_can_dual["db_modified"] is True
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Responder Cancelacion: Cancelación selectiva Calendar en cita dual actualiza DB sin retirar fila (preserva Zoom).")

    # 2F. Responder Cancelacion: Cancelación total (ambos recursos) retira la fila
    res_resp_can_both = run_node_js(code_resp_can, [{"json": {
        "token": "tok_full_123",
        "event_id": "ev-123",
        "zoom_meeting_id": 987654321,
        "op": "deleted"
    }}], mock_nodes={
        "Preparar Cancelacion": {"json": {
            "resources": ["calendar", "zoom"],
            "calendarEventId": "ev-123",
            "zoomMeetingId": "987654321"
        }},
        "Cancelar Calendar y Zoom": {"json": {
            "ok": True,
            "verified": True,
            "components": {
                "calendar": {"state": "verified", "id": "ev-123"},
                "zoom": {"state": "verified", "id": "987654321"}
            }
        }}
    })
    assert res_resp_can_both["success"] is True
    out_can_both = res_resp_can_both["result"][0]["json"]
    assert out_can_both["verified"] is True
    assert out_can_both["state"] == "cancelada"
    assert out_can_both["enlace_retirado"] is True
    assert out_can_both["enlace_actualizado"] is False
    assert out_can_both["db_modified"] is True
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Responder Cancelacion: Cancelación total de ambos recursos retira la fila de DB (enlace_retirado:true).")

    # 2G. Responder Fallo Cancelacion: Formato de fallo normalizado
    code_resp_fallo_can = nodes_can["Responder Fallo Cancelacion"]["parameters"]["jsCode"]
    res_resp_fallo_can = run_node_js(code_resp_fallo_can, [{"json": {
        "error": "El proveedor rechazó la cancelación"
    }}], mock_nodes={
        "Preparar Cancelacion": {"json": {
            "resources": ["calendar", "zoom"]
        }}
    })
    assert res_resp_fallo_can["success"] is True
    out_fallo_can = res_resp_fallo_can["result"][0]["json"]
    assert out_fallo_can["ok"] is False
    assert out_fallo_can["verified"] is False
    assert out_fallo_can["state"] == "no_cancelada"
    assert out_fallo_can["resources"] == ["calendar", "zoom"]
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Responder Fallo Cancelacion: Formato de fallo ok:false, verified:false.")

    # 2H. Cancelación sin restricción horaria: Permite retirar evento fuera de horario
    code_prep_raw_can = nodes_can["Preparar Cancelacion"]["parameters"]["jsCode"]
    res_can_unrestricted = run_node_js(code_prep_raw_can, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {
            "confirmado_por_owner": "true",
            "resources": ["calendar", "zoom"],
            "evento_id": "ev-outside-123",
            "zoom_id": "zm-outside-456"
        }
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_can_unrestricted["success"] is True
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Preparar Cancelacion: Sin restricción horaria, permite retirar eventos en cualquier horario.")

    # -------------------------------------------------------------------------
    # 3. TEST IA360CalendarBook20260602 (Raw Book Writer)
    # -------------------------------------------------------------------------
    book_wf = json.load(open(os.path.join(CANDIDATES_DIR, "IA360CalendarBook20260602.candidate.json")))
    nodes_book = {n["name"]: n for n in book_wf["nodes"]}

    code_norm_book = nodes_book["Normalize Booking"]["parameters"]["jsCode"]
    code_assert_slot = nodes_book["Assert Slot Free"]["parameters"]["jsCode"]
    code_build_book = nodes_book["Build Booking Response"]["parameters"]["jsCode"]

    # 3A. Normalize Booking flags para 3 combinaciones
    res_norm_cal = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar"], "start": "2026-08-25T16:00:00.000Z", "end": "2026-08-25T17:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_cal["success"] is True
    assert res_norm_cal["result"][0]["json"]["needCalendar"] is True
    assert res_norm_cal["result"][0]["json"]["needZoom"] is False

    res_norm_zoom = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["zoom"], "start": "2026-08-25T16:00:00.000Z", "end": "2026-08-25T17:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_zoom["success"] is True
    assert res_norm_zoom["result"][0]["json"]["needCalendar"] is False
    assert res_norm_zoom["result"][0]["json"]["needZoom"] is True

    res_norm_both = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar", "zoom"], "start": "2026-08-25T16:00:00.000Z", "end": "2026-08-25T17:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_both["success"] is True
    assert res_norm_both["result"][0]["json"]["needCalendar"] is True
    assert res_norm_both["result"][0]["json"]["needZoom"] is True
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Flags correctos para las 3 combinaciones.")

    # 3B. Assert Slot Free: libre vs ocupado sin lanzar excepciones
    res_slot_free = run_node_js(code_assert_slot, [{"json": {
        "calendars": {"ocompudoc@gmail.com": {"busy": []}}
    }}], mock_nodes={
        "If Needs Calendar": {"json": {"calendarId": "ocompudoc@gmail.com"}}
    })
    assert res_slot_free["success"] is True
    assert res_slot_free["result"][0]["json"]["slotFree"] is True
    assert res_slot_free["result"][0]["json"]["calendarError"] is None

    res_slot_busy = run_node_js(code_assert_slot, [{"json": {
        "calendars": {"ocompudoc@gmail.com": {"busy": [{"start": "2026-08-25T16:00:00Z", "end": "2026-08-25T16:30:00Z"}]}}
    }}], mock_nodes={
        "If Needs Calendar": {"json": {"calendarId": "ocompudoc@gmail.com"}}
    })
    assert res_slot_busy["success"] is True
    assert res_slot_busy["result"][0]["json"]["slotFree"] is False
    assert res_slot_busy["result"][0]["json"]["calendarError"] == "slot_busy"
    print("  [PASS] IA360CalendarBook20260602 -> Assert Slot Free: Detecta slot libre (slotFree:true) y slot ocupado (slotFree:false, calendarError:slot_busy) sin throw.")

    # 3C. Build Booking Response: Positivos reconciliados con shapes GET reales
    res_cal_only = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Cita Presencial",
            "displayName": "Lead Sintetico",
            "wa": "5213321594582"
        }},
        "Create Calendar Event": {"json": {
            "id": "ev-cal-001",
            "htmlLink": "https://calendar.google.com/event?eid=ev-cal-001"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-cal-001",
            "status": "confirmed",
            "summary": "Cita Presencial",
            "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T17:00:00.000Z"},
            "htmlLink": "https://calendar.google.com/event?eid=ev-cal-001"
        }}
    })
    assert res_cal_only["success"] is True
    out_cal_only = res_cal_only["result"][0]["json"]
    assert out_cal_only["verified"] is True
    assert out_cal_only["state"] == "agendada"
    assert "calendar" in out_cal_only["components"]
    assert "zoom" not in out_cal_only["components"]
    assert out_cal_only["components"]["calendar"]["state"] == "verified"
    assert out_cal_only["calendarEventId"] == "ev-cal-001"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Calendar-only verified:true con shape GET real.")

    res_zoom_only = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["zoom"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Videollamada 1a1",
            "displayName": "Lead Sintetico",
            "wa": "5213321594582"
        }},
        "Create Zoom Meeting": {"json": {
            "id": "987654321",
            "join_url": "https://us04web.zoom.us/j/987654321"
        }},
        "Verify Zoom Meeting": {"json": {
            "statusCode": 200,
            "body": {
                "id": "987654321",
                "start_time": "2026-08-25T16:00:00.000Z",
                "duration": 60,
                "topic": "Videollamada 1a1",
                "join_url": "https://us04web.zoom.us/j/987654321"
            }
        }}
    })
    assert res_zoom_only["success"] is True
    out_zoom_only = res_zoom_only["result"][0]["json"]
    assert out_zoom_only["verified"] is True
    assert out_zoom_only["state"] == "agendada"
    assert "zoom" in out_zoom_only["components"]
    assert "calendar" not in out_zoom_only["components"]
    assert out_zoom_only["components"]["zoom"]["state"] == "verified"
    assert out_zoom_only["zoomMeetingId"] == "987654321"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Zoom-only verified:true con shape GET real.")

    res_both_ok = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Reunión Completa",
            "displayName": "Lead Sintetico",
            "wa": "5213321594582"
        }},
        "Create Zoom Meeting": {"json": {
            "id": "555666777",
            "join_url": "https://us04web.zoom.us/j/555666777"
        }},
        "Verify Zoom Meeting": {"json": {
            "statusCode": 200,
            "body": {
                "id": "555666777",
                "start_time": "2026-08-25T16:00:00.000Z",
                "duration": 60,
                "topic": "Reunión Completa",
                "join_url": "https://us04web.zoom.us/j/555666777"
            }
        }},
        "Create Calendar Event": {"json": {
            "id": "ev-both-1",
            "htmlLink": "https://calendar.google.com/event?eid=ev-both-1"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-both-1",
            "status": "confirmed",
            "summary": "Reunión Completa",
            "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T17:00:00.000Z"},
            "htmlLink": "https://calendar.google.com/event?eid=ev-both-1"
        }}
    })
    assert res_both_ok["success"] is True
    out_both = res_both_ok["result"][0]["json"]
    assert out_both["verified"] is True
    assert out_both["components"]["calendar"]["state"] == "verified"
    assert out_both["components"]["zoom"]["state"] == "verified"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Ambos verified:true.")

    # 3D. Falla Parcial y Detección de Ocupado
    res_part_zoom_fail = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Reunión Parcial"
        }},
        "Create Zoom Meeting": {"json": {
            "error": {"message": "Zoom API Rate Limit Exceeded"}
        }},
        "Create Calendar Event": {"json": {
            "id": "ev-durable-1",
            "htmlLink": "https://calendar.google.com/event?eid=ev-durable-1"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-durable-1",
            "status": "confirmed",
            "summary": "Reunión Parcial",
            "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T17:00:00.000Z"}
        }}
    })
    assert res_part_zoom_fail["success"] is True
    out_part1 = res_part_zoom_fail["result"][0]["json"]
    assert out_part1["verified"] is False
    assert out_part1["ok"] is False
    assert out_part1["components"]["calendar"]["state"] == "verified"
    assert out_part1["components"]["calendar"]["id"] == "ev-durable-1"
    assert out_part1["calendarEventId"] == "ev-durable-1"
    assert out_part1["components"]["zoom"]["state"] == "failed"
    print("  [PASS] IA360CalendarBook20260602 -> Falla Parcial (Cal OK + Zoom Fail): verified:false, Calendar retenido durablemente.")

    res_part_cal_fail = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Reunión Parcial 2"
        }},
        "Create Zoom Meeting": {"json": {
            "id": "888999000",
            "join_url": "https://us04web.zoom.us/j/888999000"
        }},
        "Verify Zoom Meeting": {"json": {
            "statusCode": 200,
            "body": {
                "id": "888999000",
                "start_time": "2026-08-25T16:00:00.000Z",
                "duration": 60,
                "topic": "Reunión Parcial 2",
                "join_url": "https://us04web.zoom.us/j/888999000"
            }
        }},
        "Create Calendar Event": {"json": {
            "error": {"message": "Calendar API 500 Internal Error"}
        }}
    })
    assert res_part_cal_fail["success"] is True
    out_part2 = res_part_cal_fail["result"][0]["json"]
    assert out_part2["verified"] is False
    assert out_part2["ok"] is False
    assert out_part2["components"]["zoom"]["state"] == "verified"
    assert out_part2["components"]["zoom"]["id"] == "888999000"
    assert out_part2["zoomMeetingId"] == "888999000"
    assert out_part2["components"]["calendar"]["state"] == "failed"
    print("  [PASS] IA360CalendarBook20260602 -> Falla Parcial (Zoom OK + Cal Fail): verified:false, Zoom retenido durablemente.")

    res_slot_busy_partial = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Reunión Dual Slot Busy"
        }},
        "Create Zoom Meeting": {"json": {
            "id": "86317765248",
            "join_url": "https://us06web.zoom.us/j/86317765248"
        }},
        "Verify Zoom Meeting": {"json": {
            "statusCode": 200,
            "body": {
                "id": "86317765248",
                "start_time": "2026-08-25T16:00:00.000Z",
                "duration": 60,
                "topic": "Reunión Dual Slot Busy",
                "join_url": "https://us06web.zoom.us/j/86317765248"
            }
        }},
        "Assert Slot Free": {"json": {
            "calendarError": "slot_busy",
            "slotFree": False
        }}
    })
    assert res_slot_busy_partial["success"] is True
    out_busy_p = res_slot_busy_partial["result"][0]["json"]
    assert out_busy_p["verified"] is False
    assert out_busy_p["ok"] is False
    assert out_busy_p["state"] == "incierta"
    assert out_busy_p["components"]["zoom"]["state"] == "verified"
    assert out_busy_p["components"]["zoom"]["id"] == "86317765248"
    assert out_busy_p["zoomMeetingId"] == "86317765248"
    assert out_busy_p["components"]["calendar"]["state"] == "failed"
    assert out_busy_p["components"]["calendar"]["error"] == "slot_busy"
    assert out_busy_p["calendarEventId"] is None
    print("  [PASS] IA360CalendarBook20260602 -> Slot Busy Parcial: Zoom verified + Calendar failed slot_busy sin perder Zoom ID.")

    # 3E. Regresiones de Readback / Incierto
    res_zoom_no_get = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["zoom"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Zoom Sin Readback"
        }},
        "Create Zoom Meeting": {"json": {
            "id": "987654321",
            "join_url": "https://zoom.us/j/987654321"
        }}
    })
    assert res_zoom_no_get["success"] is True
    out_z_noget = res_zoom_no_get["result"][0]["json"]
    assert out_z_noget["verified"] is False
    assert out_z_noget["components"]["zoom"]["state"] == "uncertain"
    assert out_z_noget["components"]["zoom"]["id"] == "987654321"
    print("  [PASS] IA360CalendarBook20260602 -> Regresión Falta GET Zoom: components.zoom.state 'uncertain' preservando ID creado.")

    res_cal_no_get = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Calendar Sin Readback"
        }},
        "Create Calendar Event": {"json": {
            "id": "ev-cal-002"
        }}
    })
    assert res_cal_no_get["success"] is True
    out_c_noget = res_cal_no_get["result"][0]["json"]
    assert out_c_noget["verified"] is False
    assert out_c_noget["components"]["calendar"]["state"] == "uncertain"
    assert out_c_noget["components"]["calendar"]["id"] == "ev-cal-002"
    print("  [PASS] IA360CalendarBook20260602 -> Regresión Falta GET Calendar: components.calendar.state 'uncertain' preservando ID creado.")

    res_zoom_dur_diff = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["zoom"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Zoom Mismatch Duracion"
        }},
        "Create Zoom Meeting": {"json": {
            "id": "987654321",
            "join_url": "https://zoom.us/j/987654321"
        }},
        "Verify Zoom Meeting": {"json": {
            "statusCode": 200,
            "body": {
                "id": "987654321",
                "start_time": "2026-08-25T16:00:00.000Z",
                "duration": 30,
                "topic": "Zoom Mismatch Duracion"
            }
        }}
    })
    assert res_zoom_dur_diff["success"] is True
    out_z_dur = res_zoom_dur_diff["result"][0]["json"]
    assert out_z_dur["verified"] is False
    assert out_z_dur["components"]["zoom"]["state"] == "uncertain"
    print("  [PASS] IA360CalendarBook20260602 -> Regresión Zoom duración discrepante: components.zoom.state 'uncertain'.")

    res_cal_missing_status = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Calendar Status Missing"
        }},
        "Create Calendar Event": {"json": {
            "id": "ev-cal-003"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-cal-003",
            "summary": "Calendar Status Missing",
            "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T17:00:00.000Z"}
        }}
    })
    assert res_cal_missing_status["success"] is True
    out_c_nostatus = res_cal_missing_status["result"][0]["json"]
    assert out_c_nostatus["verified"] is False
    assert out_c_nostatus["components"]["calendar"]["state"] == "uncertain"
    print("  [PASS] IA360CalendarBook20260602 -> Regresión Calendar GET sin status: components.calendar.state 'uncertain'.")

    res_slot_mismatch = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar"],
            "start": "2026-08-25T16:00:00.000Z",
            "end": "2026-08-25T17:00:00.000Z",
            "summary": "Reunión Test Mismatch"
        }},
        "Create Calendar Event": {"json": {
            "id": "ev-mismatch"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-mismatch",
            "status": "confirmed",
            "summary": "Reunión Test Mismatch",
            "start": {"dateTime": "2026-08-25T18:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T19:00:00.000Z"}
        }}
    })
    assert res_slot_mismatch["success"] is True
    out_mismatch = res_slot_mismatch["result"][0]["json"]
    assert out_mismatch["verified"] is False
    assert out_mismatch["components"]["calendar"]["state"] == "uncertain"
    print("  [PASS] IA360CalendarBook20260602 -> Regresión Discrepancia de horario: components.calendar.state 'uncertain'.")

    # 3F. Normalize Booking: Validación determinista de horario laboral con precisión de milisegundos
    # Límite inferior exacto (08:00:00.000 local MX = 14:00:00.000Z) -> PASS
    res_norm_start_exact = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar"], "start": "2026-08-25T14:00:00.000Z", "end": "2026-08-25T15:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_start_exact["success"] is True
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Límite exacto 08:00:00.000 local MX aceptado.")

    # Límite superior exacto (fin 20:00:00.000 local MX = 02:00:00.000Z día siguiente) -> PASS
    res_norm_end_exact = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["zoom"], "start": "2026-08-26T01:00:00.000Z", "end": "2026-08-26T02:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_end_exact["success"] is True
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Límite exacto 20:00:00.000 local MX aceptado.")

    # Negativo: +1ms sobre 20:00 (20:00:00.001 local MX = 02:00:00.001Z) -> MUST FAIL con AGENDA_OUTSIDE_BUSINESS_HOURS
    res_norm_end_plus_1ms = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar"], "start": "2026-08-26T01:00:00.000Z", "end": "2026-08-26T02:00:00.001Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_end_plus_1ms["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_norm_end_plus_1ms["error"]
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Rechaza 20:00:00.001 (+1ms) con AGENDA_OUTSIDE_BUSINESS_HOURS.")

    # Negativo: -1ms antes de 08:00 (07:59:59.999 local MX = 13:59:59.999Z) -> MUST FAIL con AGENDA_OUTSIDE_BUSINESS_HOURS
    res_norm_start_minus_1ms = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar"], "start": "2026-08-25T13:59:59.999Z", "end": "2026-08-25T15:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_start_minus_1ms["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_norm_start_minus_1ms["error"]
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Rechaza 07:59:59.999 (-1ms) con AGENDA_OUTSIDE_BUSINESS_HOURS.")

    # Negativo: Cruce de día local
    res_norm_cross = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar"], "start": "2026-08-26T01:00:00.000Z", "end": "2026-08-26T15:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_cross["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_norm_cross["error"]
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Rechaza cruce de día local (AGENDA_OUTSIDE_BUSINESS_HOURS).")

    # Negativo: Bearer auth presente NO evade validación de horario
    res_norm_bearer_no_evasion = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar", "zoom"], "start": "2026-08-25T05:00:00.000Z", "end": "2026-08-25T06:00:00.000Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_bearer_no_evasion["success"] is False and "AGENDA_OUTSIDE_BUSINESS_HOURS" in res_norm_bearer_no_evasion["error"]
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Bearer Token válido NO evade bloqueo de horario.")

    # -------------------------------------------------------------------------
    # 4. TEST rV1z5sUdNEzCQ1tk (Raw Cancel Writer)
    # -------------------------------------------------------------------------
    cancel_wf = json.load(open(os.path.join(CANDIDATES_DIR, "rV1z5sUdNEzCQ1tk.candidate.json")))
    nodes_raw_can = {n["name"]: n for n in cancel_wf["nodes"]}

    code_norm_raw_can = nodes_raw_can["Normalize Cancel"]["parameters"]["jsCode"]
    code_build_raw_can = nodes_raw_can["Build Cancel Response"]["parameters"]["jsCode"]

    # 4A. Normalize Cancel: selective ID requirements
    res_norm_can_cal = run_node_js(code_norm_raw_can, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar"], "calendarEventId": "ev-123"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_can_cal["success"] is True
    assert res_norm_can_cal["result"][0]["json"]["needCalendar"] is True
    assert res_norm_can_cal["result"][0]["json"]["needZoom"] is False

    res_norm_can_zoom = run_node_js(code_norm_raw_can, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["zoom"], "zoomMeetingId": "zm-456"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_can_zoom["success"] is True
    assert res_norm_can_zoom["result"][0]["json"]["needCalendar"] is False
    assert res_norm_can_zoom["result"][0]["json"]["needZoom"] is True

    # 4B. Build Cancel Response: Positivos reconciliados con shapes GET reales de ausencia
    res_can_cal_ok = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["calendar"],
            "calendarEventId": "ev-123"
        }},
        "Delete Calendar Event": {"json": {
            "success": True
        }},
        "Verify Event Absence in Calendar": {"json": {
            "statusCode": 404
        }}
    })
    assert res_can_cal_ok["success"] is True
    out_can_cal = res_can_cal_ok["result"][0]["json"]
    assert out_can_cal["verified"] is True
    assert out_can_cal["state"] == "cancelada"
    assert out_can_cal["components"]["calendar"]["state"] == "verified"
    assert "zoom" not in out_can_cal["components"]
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Build Cancel Response: Cancelación selectiva Calendar-only verified:true con shape GET 404.")

    res_can_zoom_ok = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["zoom"],
            "zoomMeetingId": "zm-456"
        }},
        "Delete Zoom Meeting": {"json": {
            "success": True
        }},
        "Verify Zoom Absence": {"json": {
            "statusCode": 404
        }}
    })
    assert res_can_zoom_ok["success"] is True
    out_can_zoom = res_can_zoom_ok["result"][0]["json"]
    assert out_can_zoom["verified"] is True
    assert out_can_zoom["state"] == "cancelada"
    assert out_can_zoom["components"]["zoom"]["state"] == "verified"
    assert "calendar" not in out_can_zoom["components"]
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Build Cancel Response: Cancelación selectiva Zoom-only verified:true con shape GET 404.")

    res_can_both_ok = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["calendar", "zoom"],
            "calendarEventId": "ev-123",
            "zoomMeetingId": "zm-456"
        }},
        "Delete Calendar Event": {"json": {"success": True}},
        "Verify Event Absence in Calendar": {"json": {"statusCode": 404}},
        "Delete Zoom Meeting": {"json": {"success": True}},
        "Verify Zoom Absence": {"json": {"statusCode": 404}}
    })
    assert res_can_both_ok["success"] is True
    out_can_both_r = res_can_both_ok["result"][0]["json"]
    assert out_can_both_r["verified"] is True
    assert out_can_both_r["components"]["calendar"]["state"] == "verified"
    assert out_can_both_r["components"]["zoom"]["state"] == "verified"
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Build Cancel Response: Cancelación total Both verified:true.")

    # 4C. Build Cancel Response: Falla Parcial y Regresiones
    res_can_part = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["calendar", "zoom"],
            "calendarEventId": "ev-123",
            "zoomMeetingId": "zm-456"
        }},
        "Delete Calendar Event": {"json": {
            "success": True
        }},
        "Verify Event Absence in Calendar": {"json": {
            "statusCode": 404
        }},
        "Delete Zoom Meeting": {"json": {
            "error": {"message": "Zoom API 403 Forbidden"}
        }},
        "Verify Zoom Absence": {"json": {
            "statusCode": 200
        }}
    })
    assert res_can_part["success"] is True
    out_can_part = res_can_part["result"][0]["json"]
    assert out_can_part["verified"] is False
    assert out_can_part["components"]["calendar"]["state"] == "verified"
    assert out_can_part["components"]["zoom"]["state"] == "uncertain"
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Build Cancel Response: Cancelación parcial (Cal 404 + Zoom 200), verified:false.")

    res_can_no_verify = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["calendar"],
            "calendarEventId": "ev-123"
        }},
        "Delete Calendar Event": {"json": {
            "success": True
        }}
    })
    assert res_can_no_verify["success"] is True
    out_can_noverify = res_can_no_verify["result"][0]["json"]
    assert out_can_noverify["verified"] is False
    assert out_can_noverify["components"]["calendar"]["state"] == "failed"
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Regresión Readback Ausente en Cancel: components.calendar.state 'failed' sin confirmación GET.")

    # -------------------------------------------------------------------------
    # 5. TEST IA360ContactIntelDraft20260605 (Agent Contract Normalization)
    # -------------------------------------------------------------------------
    agent_wf = json.load(open(os.path.join(CANDIDATES_DIR, "IA360ContactIntelDraft20260605.candidate.json")))
    nodes_agent = {n["name"]: n for n in agent_wf["nodes"]}

    # 5A. Normalize WhatsApp Context
    code_norm_ctx = nodes_agent["Normalize WhatsApp Context"]["parameters"]["jsCode"]
    res_ctx = run_node_js(code_norm_ctx, [{"json": {
        "text": "quiero una sesión por zoom el viernes a las 4pm",
        "contact_number": "5213321594582",
        "wa_number": "5213321060293",
        "dry_run": True
    }}])
    assert res_ctx["success"] is True
    assert res_ctx["result"][0]["json"]["dry_run"] is True
    assert res_ctx["result"][0]["json"]["contact"]["contact_number"] == "5213321594582"
    print("  [PASS] IA360ContactIntelDraft20260605 -> Normalize WhatsApp Context: Contexto, dry_run y contacto.")

    # 5B. Identity Snapshot
    code_id_snap = nodes_agent["Identity Snapshot"]["parameters"]["jsCode"]
    res_snap = run_node_js(code_id_snap, [{"json": {
        "source": "whatsapp_incoming",
        "identity_status_seed": "known",
        "contact": {"contact_number": "5213321594582", "espo_id": "esp-1"}
    }}])
    assert res_snap["success"] is True
    out_snap = res_snap["result"][0]["json"]
    assert out_snap["identity_snapshot"]["identity_status"] == "known"
    assert out_snap["identity_snapshot"]["contact_number_present"] is True
    assert out_snap["identity_snapshot"]["espo_id_present"] is True
    print("  [PASS] IA360ContactIntelDraft20260605 -> Identity Snapshot: Snapshot de identidad generado correctamente.")

    # 5C. Normalize ForgeChat Contract
    code_contract = nodes_agent["Normalize ForgeChat Contract"]["parameters"]["jsCode"]
    res_contract = run_node_js(code_contract, [{"json": {
        "output": json.dumps({
            "reply": "Con gusto agendamos la sesión por Zoom.",
            "intent": "book",
            "action": "book",
            "date": "2026-08-28",
            "response_audience": "contact"
        })
    }}], mock_nodes={
        "Prepare RAG Pinecone Dry Run": {"json": {
            "text": "quiero una sesión por zoom",
            "input_mode": "direct",
            "contact": {"contact_number": "5213321594582"},
            "dry_run": True,
            "channel": "whatsapp"
        }}
    })
    assert res_contract["success"] is True
    out_contract = res_contract["result"][0]["json"]
    assert out_contract["intent"] == "book"
    assert out_contract["action"] == "book"
    assert out_contract["response_audience"] == "contact"
    print("  [PASS] IA360ContactIntelDraft20260605 -> Normalize Contract: Parser y contexto preservados.")

    print("\n[ALL CODE NODE UNIT TESTS PASSED] Isolated candidate JS code node contract tests complete.")

if __name__ == "__main__":
    test_harness()
