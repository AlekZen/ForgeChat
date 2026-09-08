#!/usr/bin/env python3
"""
test_candidate_harness.py — Test Harness aislado para ejecución de nodos de candidatos IA360 / Agenda.
Ejecuta las funciones JS de los candidatos bajo Node.js contra fixtures sintéticos.
Cero llamadas a producción, cero mutaciones de base de datos.
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
  const nData = __mockNodes[nodeName] || (({json.dumps(input_items[0] if input_items else {})}));
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
    print(" Candidate Workflows JS Code Nodes Test Harness (Isolated)")
    print("=================================================================")

    # 1. Test Preparar Propuesta Reserva con forma anidada de Normalize WhatsApp Context
    res_wf = json.load(open(os.path.join(CANDIDATES_DIR, "sjrkjf7IcM7ski0n.candidate.json")))
    nodes = {n["name"]: n for n in res_wf["nodes"]}
    code_prep_prop = nodes["Preparar Propuesta Reserva"]["parameters"]["jsCode"]
    
    res = run_node_js(code_prep_prop, [{"json": {
        "inicio_iso": "2026-08-25T16:00:00Z",
        "fin_iso": "2026-08-25T17:00:00Z",
        "numero_contacto": "5213321594582",
        "nombre_contacto": "Contacto Sintético Test",
        "wa_number": "5213321060293",
        "source_message_id": "msg-test-123",
        "dry_run": True
    }}])
    assert res["success"] is True, f"Failed: {res}"
    payload = res["result"][0]["json"]
    assert payload["kind"] == "book"
    assert payload["contact_number"] == "5213321594582"
    assert payload["dry_run"] is True
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Propuesta Reserva: Payload de propuesta construido correctamente.")

    # 2. Test Preparar Reserva (Owner Writer) Auth & Checks
    code_prep_res = nodes["Preparar Reserva"]["parameters"]["jsCode"]
    
    res_no_auth = run_node_js(code_prep_res, [{"json": {
        "headers": {},
        "body": {"confirmado_por_owner": "true", "inicio_iso": "2026-08-25T16:00:00Z", "fin_iso": "2026-08-25T17:00:00Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_calendar_token_123"})
    assert res_no_auth["success"] is False and "AUTH_FAILED" in res_no_auth["error"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Reserva: Rechaza petición sin Bearer token.")

    res_no_conf = run_node_js(code_prep_res, [{"json": {
        "headers": {"authorization": "Bearer secret_calendar_token_123"},
        "body": {"confirmado_por_owner": "false", "inicio_iso": "2026-08-25T16:00:00Z", "fin_iso": "2026-08-25T17:00:00Z"}
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_calendar_token_123"})
    assert res_no_conf["success"] is False and "CONFIRMACION_REQUERIDA" in res_no_conf["error"]
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Reserva: Rechaza reserva no confirmada por owner.")

    res_valid = run_node_js(code_prep_res, [{"json": {
        "headers": {"authorization": "Bearer secret_calendar_token_123"},
        "body": {
            "confirmado_por_owner": "true",
            "inicio_iso": "2026-08-25T16:00:00Z",
            "fin_iso": "2026-08-25T17:00:00Z",
            "numero_contacto": "5213321594582",
            "nombre_contacto": "Contacto Sintético Test",
            "operation_id": "prop-uuid-999"
        }
    }}], env_vars={"N8N_CALENDAR_TOKEN": "secret_calendar_token_123"})
    assert res_valid["success"] is True
    writer_item = res_valid["result"][0]["json"]
    assert len(writer_item["token"]) == 20
    assert writer_item["operation_id"] == "prop-uuid-999"
    print("  [PASS] sjrkjf7IcM7ski0n -> Preparar Reserva: Genera token 20-char y retiene operation_id.")

    # 3. Test Build Booking Response en Raw Calendar Book (IA360CalendarBook20260602)
    raw_book_wf = json.load(open(os.path.join(CANDIDATES_DIR, "IA360CalendarBook20260602.candidate.json")))
    raw_nodes = {n["name"]: n for n in raw_book_wf["nodes"]}
    code_build_book = raw_nodes["Build Booking Response"]["parameters"]["jsCode"]

    # 3A. Caso Éxito Total: Readback coincide en ID, start, end, summary y Zoom verificado
    res_book_match = run_node_js(code_build_book, [{"json": {
        "id": "ev-cal-12345",
        "htmlLink": "https://calendar.google.com/event?id=123",
        "summary": "Reunión Test",
        "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
        "end": {"dateTime": "2026-08-25T17:00:00.000Z"}
    }}], mock_nodes={
        "Merge Zoom Booking": {"json": {
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "displayName": "Lead Test",
            "wa": "5213321594582",
            "summary": "Reunión Test",
            "zoomMeetingId": "zm-999",
            "zoomJoinUrl": "https://zoom.us/j/999"
        }}
    })
    assert res_book_match["success"] is True
    out_book = res_book_match["result"][0]["json"]
    assert out_book["verified"] is True
    assert out_book["state"] == "agendada"
    assert out_book["summary"] == "Reunión Test"
    assert out_book["calendarEventId"] == "ev-cal-12345"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Readback con coincidencia exacta -> verified:true, state:agendada.")

    # 3B. Caso Falla de Readback (sin ID) -> Lanza READBACK_FAILED
    res_missing_id = run_node_js(code_build_book, [{"json": {
        "error": "Not Found"
    }}], mock_nodes={
        "Merge Zoom Booking": {"json": {
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Reunión Test"
        }}
    })
    assert res_missing_id["success"] is False and "READBACK_FAILED" in res_missing_id["error"]
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Readback sin ID lanza error explícito (sin fallback silencioso).")

    # 3C. Caso Discrepancia de Horario -> verified:false, state:incierta
    res_slot_mismatch = run_node_js(code_build_book, [{"json": {
        "id": "ev-cal-12345",
        "summary": "Reunión Test",
        "start": {"dateTime": "2026-08-25T18:00:00.000Z"},
        "end": {"dateTime": "2026-08-25T19:00:00.000Z"}
    }}], mock_nodes={
        "Merge Zoom Booking": {"json": {
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Reunión Test"
        }}
    })
    assert res_slot_mismatch["success"] is True
    out_mismatch = res_slot_mismatch["result"][0]["json"]
    assert out_mismatch["verified"] is False
    assert out_mismatch["state"] == "incierta"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Discrepancia de horario -> verified:false, state:incierta.")

    # 3D. Caso Zoom Parcial / Inválido -> verified:false, state:incierta
    res_zoom_fail = run_node_js(code_build_book, [{"json": {
        "id": "ev-cal-12345",
        "summary": "Reunión Test",
        "start": {"dateTime": "2026-08-25T16:00:00.000Z"},
        "end": {"dateTime": "2026-08-25T17:00:00.000Z"}
    }}], mock_nodes={
        "Merge Zoom Booking": {"json": {
            "start": "2026-08-25T16:00:00Z",
            "end": "2026-08-25T17:00:00Z",
            "summary": "Reunión Test",
            "zoomMeetingId": "zm-999",
            "zoomJoinUrl": "" # URL vacía / inválida
        }}
    })
    assert res_zoom_fail["success"] is True
    out_zoom_fail = res_zoom_fail["result"][0]["json"]
    assert out_zoom_fail["verified"] is False
    assert out_zoom_fail["state"] == "incierta"
    print("  [PASS] IA360CalendarBook20260602 -> Build Booking Response: Zoom incompleto/inválido -> verified:false, state:incierta.")

    # 4. Test Responder Cancelacion (F1sj5tcJVa9R3Q9Z)
    can_wf = json.load(open(os.path.join(CANDIDATES_DIR, "F1sj5tcJVa9R3Q9Z.candidate.json")))
    can_nodes = {n["name"]: n for n in can_wf["nodes"]}
    code_resp_can = can_nodes["Responder Cancelacion"]["parameters"]["jsCode"]

    # 4A. Caso Éxito Total: Proveedor 204 Y Fila Borrada en DB (RETURNING token)
    res_can_ok = run_node_js(code_resp_can, [{"json": {
        "token": "tok_cancelled_123",
        "event_id": "ev-123"
    }}], mock_nodes={
        "Preparar Cancelacion": {"json": {"calendarEventId": "ev-123"}},
        "Cancelar Calendar y Zoom": {"json": {"statusCode": 204}}
    })
    assert res_can_ok["success"] is True
    out_can = res_can_ok["result"][0]["json"]
    assert out_can["verified"] is True
    assert out_can["state"] == "cancelada"
    assert out_can["enlace_retirado"] is True
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Responder Cancelacion: Proveedor 204 + Fila DB borrada -> verified:true, state:cancelada.")

    # 4B. Caso 0 Filas en DB tras cancelación de proveedor -> verified:false, state:incierta
    res_can_no_db = run_node_js(code_resp_can, [{}], mock_nodes={
        "Preparar Cancelacion": {"json": {"calendarEventId": "ev-123"}},
        "Cancelar Calendar y Zoom": {"json": {"statusCode": 204}}
    })
    assert res_can_no_db["success"] is True
    out_can_no_db = res_can_no_db["result"][0]["json"]
    assert out_can_no_db["verified"] is False
    assert out_can_no_db["state"] == "incierta"
    assert out_can_no_db["enlace_retirado"] is False
    print("  [PASS] F1sj5tcJVa9R3Q9Z -> Responder Cancelacion: 0 filas borradas en DB -> verified:false, state:incierta.")

    print("\n[ALL HARNESS SCENARIOS PASSED] Inactive execution verification complete.")

if __name__ == "__main__":
    test_harness()
