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
    """Ejecuta un snippet de código n8n Code Node dentro de Node.js con mocks de $input, $env y $()."""
    mock_nodes_json = json.dumps(mock_nodes or {})
    runner_script = f"""
const $env = {json.dumps(env_vars or {})};
const $input = {{
  first: () => ({json.dumps(input_items[0] if input_items else {})}),
  all: () => ({json.dumps(input_items)})
}};
const __mockNodes = {mock_nodes_json};
function $(nodeName) {{
  const nData = __mockNodes[nodeName] || ({json.dumps(input_items[0] if input_items else {})});
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

    # 1D. Responder Reserva: Formato de salida con components y estado durable
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

    # 2C. Responder Cancelacion: Cancelación selectiva de Calendar en cita dual (preserva Zoom y token)
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

    # 2D. Responder Cancelacion: Cancelación total (ambos recursos) retira la fila
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

    # -------------------------------------------------------------------------
    # 3. TEST IA360CalendarBook20260602 (Raw Book Writer)
    # -------------------------------------------------------------------------
    book_wf = json.load(open(os.path.join(CANDIDATES_DIR, "IA360CalendarBook20260602.candidate.json")))
    nodes_book = {n["name"]: n for n in book_wf["nodes"]}

    code_norm_book = nodes_book["Normalize Booking"]["parameters"]["jsCode"]
    code_build_book = nodes_book["Build Booking Response"]["parameters"]["jsCode"]

    # 3A. Normalize Booking flags para 3 combinaciones
    res_norm_cal = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar"], "start": "2026-08-25T16:00:00Z", "end": "2026-08-25T17:00:00Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_cal["success"] is True
    assert res_norm_cal["result"][0]["json"]["needCalendar"] is True
    assert res_norm_cal["result"][0]["json"]["needZoom"] is False

    res_norm_zoom = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["zoom"], "start": "2026-08-25T16:00:00Z", "end": "2026-08-25T17:00:00Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_zoom["success"] is True
    assert res_norm_zoom["result"][0]["json"]["needCalendar"] is False
    assert res_norm_zoom["result"][0]["json"]["needZoom"] is True

    res_norm_both = run_node_js(code_norm_book, [{"json": {
        "headers": {"authorization": "Bearer secret_tok"},
        "body": {"resources": ["calendar", "zoom"], "start": "2026-08-25T16:00:00Z", "end": "2026-08-25T17:00:00Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_tok"})
    assert res_norm_both["success"] is True
    assert res_norm_both["result"][0]["json"]["needCalendar"] is True
    assert res_norm_both["result"][0]["json"]["needZoom"] is True
    print("  [PASS] IA360CalendarBook20260602 -> Normalize Booking: Flags correctos para las 3 combinaciones.")

    # 3B. Combinación 1: Calendar Only exitoso
    res_cal_only = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar"],
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Cita Presencial"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-cal-001",
            "summary": "Cita Presencial",
            "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T17:00:00.000Z"}
        }}
    })
    assert res_cal_only["success"] is True
    out_cal_only = res_cal_only["result"][0]["json"]
    assert out_cal_only["verified"] is True
    assert out_cal_only["state"] == "agendada"
    assert "calendar" in out_cal_only["components"]
    assert "zoom" not in out_cal_only["components"]
    assert out_cal_only["components"]["calendar"]["state"] == "verified"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Calendar-only verified:true, sin componente Zoom.")

    # 3C. Combinación 2: Zoom Only exitoso
    res_zoom_only = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["zoom"],
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Videollamada 1a1"
        }},
        "Create Zoom Meeting": {"json": {
            "id": 987654321,
            "join_url": "https://us04web.zoom.us/j/987654321"
        }}
    })
    assert res_zoom_only["success"] is True
    out_zoom_only = res_zoom_only["result"][0]["json"]
    assert out_zoom_only["verified"] is True
    assert out_zoom_only["state"] == "agendada"
    assert "zoom" in out_zoom_only["components"]
    assert "calendar" not in out_zoom_only["components"]
    assert out_zoom_only["components"]["zoom"]["state"] == "verified"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Zoom-only verified:true, sin componente Calendar.")

    # 3D. Combinación 3: Ambos exitosos
    res_both_ok = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Reunión Completa"
        }},
        "Create Zoom Meeting": {"json": {
            "id": 555666777,
            "join_url": "https://us04web.zoom.us/j/555666777"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-both-1",
            "summary": "Reunión Completa",
            "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T17:00:00.000Z"}
        }}
    })
    assert res_both_ok["success"] is True
    out_both = res_both_ok["result"][0]["json"]
    assert out_both["verified"] is True
    assert out_both["components"]["calendar"]["state"] == "verified"
    assert out_both["components"]["zoom"]["state"] == "verified"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Ambos verified:true.")

    # 3E. Falla Parcial Dirección 1: Calendar OK + Zoom Falla
    res_part_zoom_fail = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Reunión Parcial"
        }},
        "Create Zoom Meeting": {"json": {
            "error": {"message": "Zoom API Rate Limit Exceeded"}
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-durable-1",
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
    assert out_part1["components"]["zoom"]["state"] == "failed"
    print("  [PASS] IA360CalendarBook20260602 -> Falla Parcial (Cal OK + Zoom Fail): verified:false, Calendar retenido durablemente.")

    # 3F. Falla Parcial Dirección 2: Zoom OK + Calendar Falla
    res_part_cal_fail = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar", "zoom"],
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Reunión Parcial 2"
        }},
        "Create Zoom Meeting": {"json": {
            "id": 888999000,
            "join_url": "https://us04web.zoom.us/j/888999000"
        }},
        "Verify Calendar Event Exists": {"json": {
            "error": {"message": "Calendar API 500 Internal Error"}
        }}
    })
    assert res_part_cal_fail["success"] is True
    out_part2 = res_part_cal_fail["result"][0]["json"]
    assert out_part2["verified"] is False
    assert out_part2["ok"] is False
    assert out_part2["components"]["zoom"]["state"] == "verified"
    assert out_part2["components"]["zoom"]["id"] == "888999000"
    assert out_part2["components"]["calendar"]["state"] == "failed"
    print("  [PASS] IA360CalendarBook20260602 -> Falla Parcial (Zoom OK + Cal Fail): verified:false, Zoom retenido durablemente.")

    # 3G. Timeout / 200 Vacío / Readback Incierto
    res_slot_mismatch = run_node_js(code_build_book, [{}], mock_nodes={
        "Normalize Booking": {"json": {
            "resources": ["calendar"],
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Reunión Test"
        }},
        "Verify Calendar Event Exists": {"json": {
            "id": "ev-mismatch",
            "summary": "Reunión Test",
            "start": {"dateTime": "2026-08-25T18:00:00.000Z"},
            "end": {"dateTime": "2026-08-25T19:00:00.000Z"}
        }}
    })
    assert res_slot_mismatch["success"] is True
    out_mismatch = res_slot_mismatch["result"][0]["json"]
    assert out_mismatch["verified"] is False
    assert out_mismatch["components"]["calendar"]["state"] == "uncertain"
    print("  [PASS] IA360CalendarBook20260602 -> Discrepancia de horario: components.calendar.state 'uncertain'.")

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

    # 4B. Build Cancel Response: Calendar Only Cancel
    res_can_cal_ok = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["calendar"],
            "calendarEventId": "ev-123"
        }},
        "Verify Event Absence in Calendar": {"json": {
            "statusCode": 404
        }}
    })
    assert res_can_cal_ok["success"] is True
    out_can_cal = res_can_cal_ok["result"][0]["json"]
    assert out_can_cal["verified"] is True
    assert out_can_cal["components"]["calendar"]["state"] == "verified"
    assert "zoom" not in out_can_cal["components"]
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Build Cancel Response: Cancelación selectiva Calendar-only verified:true.")

    # 4C. Build Cancel Response: Zoom Only Cancel
    res_can_zoom_ok = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["zoom"],
            "zoomMeetingId": "zm-456"
        }},
        "Delete Zoom Meeting": {"json": {
            "success": True
        }}
    })
    assert res_can_zoom_ok["success"] is True
    out_can_zoom = res_can_zoom_ok["result"][0]["json"]
    assert out_can_zoom["verified"] is True
    assert out_can_zoom["components"]["zoom"]["state"] == "verified"
    assert "calendar" not in out_can_zoom["components"]
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Build Cancel Response: Cancelación selectiva Zoom-only verified:true.")

    # 4D. Build Cancel Response: Cancelación Parcial (Cal OK + Zoom Falla)
    res_can_part = run_node_js(code_build_raw_can, [{}], mock_nodes={
        "Normalize Cancel": {"json": {
            "resources": ["calendar", "zoom"],
            "calendarEventId": "ev-123",
            "zoomMeetingId": "zm-456"
        }},
        "Delete Zoom Meeting": {"json": {
            "error": {"message": "Zoom API 403 Forbidden"}
        }},
        "Verify Event Absence in Calendar": {"json": {
            "statusCode": 404
        }}
    })
    assert res_can_part["success"] is True
    out_can_part = res_can_part["result"][0]["json"]
    assert out_can_part["verified"] is False
    assert out_can_part["components"]["calendar"]["state"] == "verified"
    assert out_can_part["components"]["zoom"]["state"] == "failed"
    print("  [PASS] rV1z5sUdNEzCQ1tk -> Build Cancel Response: Cancelación parcial detectada, verified:false.")

    # -------------------------------------------------------------------------
    # 5. TEST IA360ContactIntelDraft20260605 (Agent Contract Normalization)
    # -------------------------------------------------------------------------
    agent_wf = json.load(open(os.path.join(CANDIDATES_DIR, "IA360ContactIntelDraft20260605.candidate.json")))
    nodes_agent = {n["name"]: n for n in agent_wf["nodes"]}

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
        "Normalize WhatsApp Context": {"json": {
            "text": "quiero una sesión por zoom",
            "input_mode": "direct",
            "contact": {"contact_number": "5213321594582"},
            "dry_run": True
        }}
    })
    assert res_contract["success"] is True
    out_contract = res_contract["result"][0]["json"]
    assert out_contract["intent"] == "book"
    assert out_contract["action"] == "book"
    assert out_contract["response_audience"] == "contact"
    print("  [PASS] IA360ContactIntelDraft20260605 -> Normalize Contract: Parser y contexto preservados.")

    print("\n[ALL 17 HARNESS SCENARIOS PASSED] Isolated candidate JS code node contract tests complete.")

if __name__ == "__main__":
    test_harness()
