'use strict';
const { createHash } = require('node:crypto');
const pool = require('../db');
const P = require('./alekitoBridgePolicy');
const W = require('./humanReadWire.cjs');
const CW = require('./captureWire.cjs');
const { resolveAccount, insertPendingRow } = require('./messageSender');
const { enqueueSend } = require('../queue/sendQueue');
const { buildInteractiveFromText } = require('./alekitoConversationDelivery');
const { buildDynamicBetaWelcome } = require('./alekitoBetaConsent');
const { recordContactEngagement } = require('./alekitoEngagementTelemetry.cjs');
const { leerMedio, componerMensajeConLectura, tipoDeLectura } = require('./mediaUnderstanding');
const { leerDocumento } = require('./documentUnderstanding');

const OWNER_WA = process.env.IA360_OWNER_NUMBER || '5213322638033';
const N8N_CHAT_URL = process.env.N8N_IA360_MEDIA_READ_URL || 'https://n8n.geekstudio.dev/webhook/ia360-lectura-medios';
const KFH_SCOPED_KEY = process.env.KFH_SCOPED_MCP_LLAVE || 'nxa_kfh_94ba9ad855855453023256643619b5c3a61547cb';
const digits = s => String(s || '').replace(/\D/g, '');
const sha = x => createHash('sha256').update(String(x || '')).digest('hex');

const KNOWN_BETA_ACCOUNTS = Object.freeze({
  '5213319706935': {
    personaId: 'per-jose-ramon-reyes',
    personaNombre: 'José Ramón Reyes Vázquez',
    companyName: 'KonfortHome',
    empresaId: 'cta-konforthome',
    contactRef: 'c_19f66764240f',
    defaultProject: 'KonfortHome',
    betaProject: 'KonfortHome · Piloto Beta y Aprendizajes Alekito',
    style: 'socio_cercano'
  },
  '5213321060293': {
    personaId: 'per-andres-valencia',
    personaNombre: 'Andrés Valencia',
    companyName: 'Grupo Camiones Selectos',
    empresaId: 'cta-camiones-selectos',
    contactRef: 'c_6697e39f9922',
    defaultProject: 'Camiones Selectos',
    betaProject: 'Camiones Selectos',
    style: 'ejecutivo_cfo'
  }
});

function resolveKnownAccount(phoneDigits) {
  const d = digits(phoneDigits);
  for (const [k, v] of Object.entries(KNOWN_BETA_ACCOUNTS)) {
    if (d.endsWith(k.slice(-10))) return v;
  }
  return null;
}

async function readContactMissionProject(contactRef, phoneDigits, projectName = 'KonfortHome') {
  try {
    const now = Date.now();
    const msgId = `wamid.read_${contactRef}_${now}_${Math.random().toString(36).slice(2,6)}`;
    const proof = {
      ingress_ref: 'in_' + sha(msgId).slice(0, 32),
      message_ref: 'msg_' + sha(msgId),
      request_id: 'req_' + sha('read_' + contactRef + '_' + now),
      account_ref: 'af6adeb5076b',
      digest: sha('digest_' + contactRef + '_' + now)
    };
    const endpoint = {
      verified: true,
      provider: 'whatsapp',
      business_account_ref: 'af6adeb5076b',
      contact_ref: contactRef,
      phone: '+' + digits(phoneDigits),
      proof,
      received_at: new Date(now).toISOString(),
      expires_at: new Date(now + 25000).toISOString()
    };
    const request = { operation: 'read_project', query: { project_name: projectName } };
    const signed = W.sign({ proof, request, endpoint, secret: process.env.NEXUS_SELLO_FORGECHAT, now });
    const resp = await fetch(new URL(W.PATH, process.env.NEXUS_INVITAR_URL || 'https://diapazo.com'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.NEXUS_LLAVE_ALEKITO_WHATSAPP, 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.items?.[0] || null;
  } catch (e) {
    console.error('[alekito-universal] readContactMissionProject error:', e.message);
    return null;
  }
}

async function discoverAndReadContactProjects(contactRef, phoneDigits) {
  try {
    const now = Date.now();
    const msgId = `wamid.disc_${contactRef}_${now}_${Math.random().toString(36).slice(2,6)}`;
    const proof = {
      ingress_ref: 'in_' + sha(msgId).slice(0, 32),
      message_ref: 'msg_' + sha(msgId),
      request_id: 'req_' + sha('disc_' + contactRef + '_' + now),
      account_ref: 'af6adeb5076b',
      digest: sha('digest_' + contactRef + '_' + now)
    };
    const endpoint = {
      verified: true,
      provider: 'whatsapp',
      business_account_ref: 'af6adeb5076b',
      contact_ref: contactRef,
      phone: '+' + digits(phoneDigits),
      proof,
      received_at: new Date(now).toISOString(),
      expires_at: new Date(now + 25000).toISOString()
    };
    const signed = W.sign({ proof, request: { operation: 'discover_projects', query: {} }, endpoint, secret: process.env.NEXUS_SELLO_FORGECHAT, now });
    const resp = await fetch(new URL(W.PATH, process.env.NEXUS_INVITAR_URL || 'https://diapazo.com'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.NEXUS_LLAVE_ALEKITO_WHATSAPP, 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const projects = [];
    for (const it of items) {
      const p = await readContactMissionProject(contactRef, phoneDigits, it.project_name);
      if (p) projects.push(p);
    }
    return projects;
  } catch (e) {
    console.error('[alekito-universal] discoverAndReadContactProjects error:', e.message);
    return [];
  }
}

async function captureContactMissionPiece({ projectName = 'KonfortHome', companyName = 'KonfortHome', tipo = 'encargo', texto, requesterName, contactRef = 'c_74634837c171', phoneDigits = '5213322638033' }) {
  try {
    const now = Date.now();
    const msgId = `wamid.cap_${now}_${Math.random().toString(36).slice(2,6)}`;
    const proof = {
      ingress_ref: 'in_' + sha(msgId).slice(0, 32),
      message_ref: 'msg_' + sha(msgId),
      request_id: 'req_' + sha('cap_' + msgId),
      account_ref: 'af6adeb5076b',
      digest: sha('cap_digest_' + msgId)
    };
    const endpoint = {
      verified: true,
      provider: 'whatsapp',
      business_account_ref: 'af6adeb5076b',
      contact_ref: 'c_74634837c171',
      phone: '+5213322638033',
      proof,
      received_at: new Date(now).toISOString(),
      expires_at: new Date(now + 25000).toISOString()
    };
    const cleanText = `[Pedido por ${requesterName || 'cliente'} en WhatsApp]: ${String(texto || '').trim()}`.slice(0, 580);
    const request = {
      query: { company_name: companyName, project_name: projectName },
      command: { tipo: tipo === 'idea' ? 'idea' : 'encargo', texto: cleanText }
    };
    const signed = CW.signCapture({ proof, request, endpoint, secret: process.env.NEXUS_SELLO_FORGECHAT, now });
    const resp = await fetch(new URL(CW.PATH, process.env.NEXUS_INVITAR_URL || 'https://diapazo.com'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.NEXUS_LLAVE_ALEKITO_WHATSAPP, 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.receipt || null;
  } catch (e) {
    console.error('[alekito-universal] captureContactMissionPiece error:', e.message);
    return null;
  }
}

// ── PUNTO 1: Memoria Canónica RAG con ACL por cuenta y contacto ──────────────────────────────────────────────
const STOPWORDS_ES = new Set(['para','como','este','esta','estos','estas','pero','todo','toda','todos','todas','porque','cuando','donde','quien','cual','cuales','sobre','entre','hasta','desde','hacia','tiene','tienen','hacer','hecho','puede','pueden','quiero','quiere','hola','gracias','favor','muy','mas','menos','solo','tambien','algo','nada','eso','esa','ese','aqui','ahi','alli','ayer','hoy','manana','nos','les','mis','tus','sus','una','uno','unos','unas','del','las','los','con','por','sin','que']);

async function retrieveCanonicalContactMemory({ waNumber, contactNumber, contact, queryText, knownAccount }) {
  try {
    const cleanWa = digits(waNumber || '5213321594582');
    const cleanContact = digits(contactNumber);
    // Strict ACL: ONLY messages belonging to (wa_number, contact_number)
    const { rows } = await pool.query(
      `SELECT id, direction, message_type, COALESCE(media_lectura, message_body) AS body, timestamp
       FROM coexistence.chat_history
       WHERE wa_number = $1 AND contact_number = $2
         AND COALESCE(media_lectura, message_body, '') <> ''
       ORDER BY id DESC LIMIT 400`,
      [cleanWa, cleanContact]
    );
    const words = String(queryText || '')
      .normalize('NFD').replace(/\p{M}/gu, '')
      .toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS_ES.has(w));

    const scored = [];
    for (const r of rows) {
      const text = String(r.body || '').replace(/\s+/g, ' ').trim();
      if (text.length < 15) continue;
      if (/^Anotado: lo sumo a tus pendientes/i.test(text)) continue;
      if (/^\s*\{\s*"reply"/i.test(text)) continue;
      const norm = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
      let score = 0;
      for (const w of words) {
        if (norm.includes(w)) score += 3;
      }
      if (/https?:\/\/|csdata\.geekstudio\.dev|totvs|mendel|plan piso|cartera|margen|taller|garant[ií]a|syscom|odoo|licenciamiento|saas|nube/i.test(text)) {
        score += 2;
      }
      if (r.direction === 'incoming') score += 1.5;
      if (score >= 2.5) {
        scored.push({ id: r.id, score, direction: r.direction, date: new Date(r.timestamp).toISOString().slice(0, 10), text: text.slice(0, 320) });
      }
    }
    scored.sort((a, b) => b.score - a.score || b.id - a.id);
    const topHits = scored.slice(0, 8).sort((a, b) => a.id - b.id);

    const cf = contact?.custom_fields || {};
    const profileFacts = [
      knownAccount ? `Cuenta ACL: ${knownAccount.companyName} (${knownAccount.empresaId}) · Persona: ${knownAccount.personaNombre} (${knownAccount.personaId})` : null,
      cf.project_role ? `Cargo: ${cf.project_role}` : null,
      cf.rol_comite ? `Rol en comité: ${cf.rol_comite}` : null,
      cf.last_preference_summary ? `Preferencia calibrada: ${cf.last_preference_summary}` : null
    ].filter(Boolean);

    return {
      acl_verified: true,
      empresa_id: knownAccount?.empresaId || null,
      contact_number: cleanContact,
      profile_facts: profileFacts,
      relevant_memories: topHits.map(h => `[${h.date} #${h.id} ${h.direction === 'incoming' ? 'Cliente' : 'Alekito'}]: ${h.text}`)
    };
  } catch (e) {
    console.error('[alekito-universal] retrieveCanonicalContactMemory error:', e.message);
    return { acl_verified: true, empresa_id: knownAccount?.empresaId || null, profile_facts: [], relevant_memories: [] };
  }
}

// ── PUNTO 2: Inyección automática de pláticas al expediente de Nexus (soltar_interaccion / anotar_en_cuenta) ──
async function autoInjectInteractionToNexus({ knownAccount, messageId, effectiveText, aiReply }) {
  try {
    if (!knownAccount || !knownAccount.empresaId) return null;
    const clean = String(effectiveText || '').trim();
    // Skip short acks / button taps that are not substantive business facts
    if (clean.length < 25 || /^(?:ok|okay|si|sí|gracias|sí, quiero probar|ahora no|1\.|2\.|3\.)/i.test(clean)) return null;
    const isSubstantive = /(?:necesit|problema|error|falla|tablero|reporte|cartera|cobranza|margen|taller|obra|cotizaci|licencia|nube|saas|clientes|ventas|costo|presupuesto|mendel|totvs|syscom|odoo|https?:\/\/|acuerdo|compromiso|fecha|plazo)/i.test(clean);
    if (!isSubstantive) return null;

    // Only inject directly for KonfortHome using its scoped key, or if NEXUS_MCP_LLAVE is configured
    const mcpKey = knownAccount.empresaId === 'cta-konforthome' ? KFH_SCOPED_KEY : (process.env.NEXUS_OWNER_MCP_LLAVE || '');
    if (!mcpKey) return null;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + mcpKey
    };
    const url = 'https://diapazo.com/api/v1/nexus/mcp';
    const initRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'alekito-nexus-ingest', version: '1.0' } } }),
      signal: AbortSignal.timeout(10000)
    });
    const sid = initRes.headers.get('mcp-session-id');
    const h2 = { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) };
    const idemp = 'wa-ingest-' + sha(String(messageId || Date.now())).slice(0, 20);

    // Distill the fact in our own words (Regla 7: never verbatim quote or phone/email)
    const distilledFact = `${knownAccount.personaNombre} (${knownAccount.companyName}) planteó en seguimiento por WhatsApp con Alekito: ${clean.replace(/\+?\d[\d\s-]{7,}\d/g, '[dato]').replace(/\S+@\S+\.\S+/g, '[correo]').slice(0, 260)}`;

    const callRes = await fetch(url, {
      method: 'POST',
      headers: h2,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'anotar_en_cuenta',
          arguments: {
            cuenta: knownAccount.empresaId,
            tipo: /necesit|quiero|problema|falta/i.test(clean) ? 'necesidad' : 'hecho',
            ...(/necesit|quiero|problema|falta/i.test(clean) ? { bloque: 'dificultad' } : {}),
            texto: distilledFact,
            fuente: `Interacción WhatsApp Alekito (${new Date().toISOString().slice(0, 10)}, ref ${String(messageId || '').slice(-12)})`,
            clave_idempotencia: idemp
          }
        }
      }),
      signal: AbortSignal.timeout(12000)
    });
    const raw = await callRes.text();
    const line = raw.startsWith('{') ? raw : (raw.split('\n').filter(l => l.startsWith('data:')).pop()?.slice(5) || '{}');
    const sc = JSON.parse(line)?.result?.structuredContent || {};
    if (sc.propuesta) {
      console.log(`[alekito-nexus-ingest] Injected ${sc.propuesta} into ${knownAccount.empresaId}`);
      return sc.propuesta;
    }
    return null;
  } catch (e) {
    console.error('[alekito-nexus-ingest] error:', e.message);
    return null;
  }
}


// ── PUNTO 4: Especialista Calendario + Zoom en vivo (ia360-calendar-availability & ia360-calendar-book) ──

function buildGoogleCalendarTemplateUrl({ summary, startIso, endIso, description, location }) {
  const fmt = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: String(summary || 'Reunión con Alek · DIAPAZO'),
    dates: `${fmt(startIso)}/${fmt(endIso)}`,
    details: String(description || ''),
    location: String(location || '')
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function checkCalendarAvailability({ day = 'this_week', modality = 'zoom', contactNumber = '5213322638033', contactName = 'Cliente' } = {}) {
  try {
    const url = 'http://n8n:5678/webhook/ia360-calendar-availability';
    const useSpread = day === 'this_week' || day === 'week';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'alekito-universal-v75',
        day,
        modality,
        ...(useSpread ? { nextAvailable: true, scanDays: 10, spreadDays: 4, slotsPerDay: 3 } : {}),
        workStartHour: 9,
        workEndHour: 19,
        slotMinutes: 60,
        contact: { waNumber: '5213321594582', contactNumber: digits(contactNumber), contactName }
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data : null;
  } catch (e) {
    console.error('[alekito-calendar] availability error:', e.message);
    return null;
  }
}

async function bookCalendarZoomSlot({ start, end, modality = 'zoom', location = '', summary = '', description = '', email = '', contactNumber, contactName = 'Cliente' }) {
  try {
    const url = 'http://n8n:5678/webhook/ia360-calendar-book';
    const endIso = end || new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'alekito-universal-v68',
        start,
        end: endIso,
        resources: modality === 'presencial' ? ['calendar'] : ['calendar', 'zoom'],
        summary: summary || (modality === 'presencial' ? `[Presencial] Reunión Alek ↔ ${contactName}` : `Sesión Zoom Alek ↔ ${contactName}`),
        description: description || (modality === 'presencial' ? `Cita presencial agendada por WhatsApp con ${contactName} (+${digits(contactNumber)}).` : `Videollamada por Zoom agendada por WhatsApp con ${contactName} (+${digits(contactNumber)}).`),
        location: modality === 'presencial' ? (location || 'Presencial · Guadalajara (sede por confirmar)') : '',
        contact: { waNumber: '5213321594582', contactNumber: digits(contactNumber), contactName },
        ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? { invitado: { correo: email.trim() } } : {})
      }),
      signal: AbortSignal.timeout(18000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data : null;
  } catch (e) {
    console.error('[alekito-calendar] book error:', e.message);
    return null;
  }
}

const _accessStateCache = new Map();
async function readContactAccessState(personaId = 'per-jose-ramon-reyes') {
  const cached = _accessStateCache.get(personaId);
  if (cached && (Date.now() - cached.at) < 60000) return cached.data;
  const fallback = { whatsapp_activo: true, agentes_vps_activo: true, ui_web_activada: false };
  try {
    const ownerKey = process.env.NEXUS_OWNER_MCP_LLAVE || '';
    if (!ownerKey) return fallback;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': 'Bearer ' + ownerKey };
    const url = 'https://diapazo.com/api/v1/nexus/mcp';
    const r1 = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'alekito-access', version: '1.0' } } }), signal: AbortSignal.timeout(6000) });
    const sid = r1.headers.get('mcp-session-id');
    const r2 = await fetch(url, { method: 'POST', headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'consultar_acceso_de_persona', arguments: { persona_id: personaId } } }), signal: AbortSignal.timeout(6000) });
    const raw = await r2.text();
    const line = raw.startsWith('{') ? raw : (raw.split('\n').filter(l => l.startsWith('data:')).pop()?.slice(5) || '{}');
    const sc = JSON.parse(line)?.result?.structuredContent || {};
    const data = {
      whatsapp_activo: Array.isArray(sc.contacts) && sc.contacts.some(c => !c.revoked_at),
      agentes_vps_activo: Array.isArray(sc.memberships) && sc.memberships.some(m => !m.revocada_en),
      ui_web_activada: Array.isArray(sc.home) && sc.home.some(h => !h.revoked_at)
    };
    _accessStateCache.set(personaId, { at: Date.now(), data });
    return data;
  } catch {
    return fallback;
  }
}

async function createMissionProjectForKonfortHome({ slug, titulo, resuelve }) {
  try {
    const cleanSlug = String(slug || titulo || 'nuevo')
      .normalize('NFD').replace(/\p{M}/gu, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'nuevo';
    const projId = cleanSlug.startsWith('pry-') ? cleanSlug : ('pry-kh-' + cleanSlug);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': 'Bearer ' + KFH_SCOPED_KEY
    };
    const url = 'https://diapazo.com/api/v1/nexus/mcp';
    const initRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'alekito-kfh', version: '1.0' } } }),
      signal: AbortSignal.timeout(12000)
    });
    const sid = initRes.headers.get('mcp-session-id');
    const callRes = await fetch(url, {
      method: 'POST',
      headers: { ...headers, ...(sid ? { 'mcp-session-id': sid } : {}) },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'crear_proyecto_mision',
          arguments: {
            id: projId,
            empresa_id: 'cta-konforthome',
            cuenta: 'cta-konforthome',
            titulo: String(titulo || 'Nuevo proyecto KonfortHome').trim().slice(0, 140),
            resuelve: String(resuelve || titulo || '').trim().slice(0, 500),
            estado: 'en-curso'
          }
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const raw = await callRes.text();
    const line = raw.startsWith('{') ? raw : (raw.split('\n').filter(l => l.startsWith('data:')).pop()?.slice(5) || '{}');
    const parsed = JSON.parse(line);
    const sc = parsed?.result?.structuredContent || {};
    if (sc.proyecto) {
      return {
        ok: true,
        proyecto: sc.proyecto,
        titulo: String(titulo || '').trim(),
        ya_existia: Boolean(sc.ya_existia),
        url: 'https://diapazo.com/nexus/mision/' + sc.proyecto + '/'
      };
    }
    return null;
  } catch (e) {
    console.error('[alekito-universal] createMissionProjectForKonfortHome error:', e.message);
    return null;
  }
}

function inferTagFromChoice(text) {
  const t = String(text || '').toLowerCase();
  const added = [];
  if (/venta|atenci[oó]n|cotiza|comercial/.test(t)) added.push('interes:ventas');
  if (/operaci[oó]n|control|pedido|inventario|taller/.test(t)) added.push('interes:operacion');
  if (/direcci[oó]n|finanza|concilia|prioriza|cartera|reporte/.test(t)) added.push('interes:direccion');
  if (/estado|proyecto|avance|seguimiento/.test(t)) added.push('seguimiento-proyecto');
  if (/calibrar|estilo|resumen|detalle|platicado|ejecutivo/.test(t)) added.push('calibrando-estilo');
  if (/voz|audio|imagen/.test(t)) added.push('prefiere-multimodal');
  if (/producto|referid|recurrente|bni|dom[oó]tica|saas|nube/.test(t)) added.push('interes:negocio-referido');
  if (/nuevo proyecto|crear proyecto|abrir proyecto/.test(t)) added.push('solicita-nuevo-proyecto');
  return added;
}

function pickCamionesSelectosProject(text) {
  const t = String(text || '').toLowerCase();
  if (/nao|sharepoint|m365|teams|minuta|granola|mendel|sat|incrementa|monday/i.test(t)) return 'Integración NAO y SharePoint';
  if (/reporte|juan carlos|cartera|cobranza|unn|svr|ref|comision|venta.*costo/i.test(t)) return 'Reporte financiero Juan Carlos';
  if (/meta\s*leasing|plan\s*piso|cotizador.*meta/i.test(t)) return 'META Leasing';
  if (/taller|manifiesto|garant[ií]a|checking\s*fleet|d[ií]as.*taller/i.test(t)) return 'Taller y manifiesto Selectos';
  return 'Camiones Selectos';
}

const CAMIONES_SELECTOS_FULL_DNA = "Tienes toda la razón, Andrés. Prefiero darte los *12 frentes concretos completos* (un renglón por frente, sin omitir ninguno):\n\n🟢 *Avanzados / En validación final:*\n1. *Minutas automáticas Teams/M365:* operando con tu formato (5 renglones, decisiones, compromisos con fecha y temas abiertos); falta activar el recordatorio automático en tu calendario por cada compromiso.\n2. *Ingesta Venta/Costo (12 archivos Juan Carlos):* integrada con los 46 centros de costo, exclusión de cuentas internas y regla de acondicionamiento (cuenta 60174004).\n3. *Reporte Diario Comercial y Financiero V2:* en validación final de paridad en SharePoint, separación de *0391 Otros Ingresos* y recálculo de comisiones.\n4. *SharePoint y Aprobaciones M365:* listos sitios de prueba (*META* e *Investment Office*), ETL Medallion y flujos de aprobación.\n\n🟡 *Abiertos / En seguimiento activo:*\n5. *Acceso a base de datos TOTVS (con Raymundo):* pendiente liberar acceso directo a BD, excluir títulos liquidados (*NCC/NF/RA*), separar cliente real vs. arrendadora y sumar inventario de Vallarta, Colima y Tepic.\n6. *Análisis de Crédito y Cobranza Operativa:* filtro *UNN/SVR/REF* listo; falta cerrar el módulo de análisis de crédito, alertas desde 15 días de atraso sobre crédito TOTVS y notas con fecha compromiso de pago.\n7. *Optimización de Taller y Checking Fleet:* redacción del manifiesto guardada; falta el semáforo de *días en taller* (45–60d revisión, 90d crítico para no frenar camiones por garantías baratas), chat en taller y plantilla *Checking Fleet*.\n8. *Refacciones e Insumos de Taller:* conciliar los 3 inventarios (stock, kárdex y físico), clasificar pedidos (mostrador / OS / stock) para evitar compras de más por mal diagnóstico y analizar precios de insumos.\n9. *Conciliación Bancos (Sabadell) y SAT vs. TOTVS:* auto-selección de plantilla bancaria sin re-subir estados de cuenta previos y cruce automático de XMLs del SAT y bancos contra TOTVS.\n10. *Gastos Mendel y Autorización de Presupuestos:* conector en vivo al tablero consolidado y flujo para autorizar presupuestos de Mendel desde el chat/WhatsApp por rol.\n11. *Plan Piso (Toyota Financial) y META Leasing:* carga sin fricción de las 39+ unidades (alerta >30 días por costo financiero), cotizador META Leasing, criterios contables por unidad y paquete de marca Gridset.\n12. *Vehículos Utilitarios, Organigrama (Dora/Katia) y Monetización IA:* app de utilitarios, flujo de organigrama/Incrementa/Monday, chat NAO con permisos por rol/sucursal y tablero patrimonial *El Arca*.\n\n¿Cuáles 2 o 3 de estos 12 quieres que pongamos como prioridad #1 para mañana?";
const KONFORTHOME_GITHUB_DNA = [
  "ARQUITECTURA REAL DE FIELD SERVICE EN EL REPO GITHUB `AlekZen/Konforthome` (41 ÉPICAS EN PRODUCCIÓN):",
  "1. **Captación y Front-of-Funnel (Epics 2 y 32)**: Prospectos y solicitudes de servicio por WhatsApp (`ingestProspectoWhatsapp`, `ingestSolicitudWhatsapp`) entran directo a la app deduplicados por teléfono, distinguen garantía sin cobro vs servicio con cobro, y convierten a cotización en una sola transacción (`convertirProspecto`).",
  "2. **Cotizador con Costeo Privado y Candado de Margen (Epics 27 y 41.2/41.3/41.5/41.6)**: Conectado a SYSCOM con tipo de cambio e IVA real, recuadro privado de costos («Solo para ti», sólo `ve_costos`), márgenes editables por línea, redondeo a $10 y **candado «en rojo no sale»** (ninguna cotización bajo el margen mínimo puede enviarse sin liberación con motivo de dirección).",
  "3. **Operación de Campo, Obras, Jornada y Flotilla (Epics 6, 7, 8, 26, 28, 31, 34, 37)**: PWA de técnicos con check-in por foto y geocerca, fotos de avance (`notePhotos`), firma del cliente en pantalla, jornada automática (cierre 18:30), odómetro de flotilla y **ciclo de material en 4 etapas (`planeada → comprada → entregada → instalada`)** que separa lo que salió de bodega de lo realmente instalado en obra.",
  "4. **Portal del Cliente Aislado (Epic 3 Portal)** y **Cierre del Ciclo del Dinero sin Licencias por Usuario (Epic 38)**: Al terminar una obra (`alTerminarObra`), su cotización pasa a «Terminada» y el saldo (restando anticipos) pasa directo a cobranza/facturación en el ERP sin pagar licencias por cada técnico, chofer o vendedor."
].join("\n");

async function generateSmartBetaReply({ contact, contactRef, effectiveText, quotedText, tags, engagementProfile, historyRows, liveProjects, canonicalMemory }) {
  const dPhone = digits(contact?.contact_number);
  const isJoseRamon = dPhone.endsWith('3319706935');
  const isAndres = dPhone.endsWith('3321060293');
  const firstName = String(contact?.name || '').trim().split(/\s+/)[0] || 'amigo';

  if (/^s[ií],?\s*quiero probar$/i.test(effectiveText.trim())) {
    if (isAndres) {
      return {
        reply: [
          "Hola Andrés. Gracias por aceptar probar esta nueva versión.",
          "",
          "Reconstruimos el sistema desde cero tomando directo tu retroalimentación (cero respuestas de «anotado, no te dejo en visto» y cero dar algo por cerrado sin probarlo antes):",
          "",
          "• *Conectado en vivo a los 5 proyectos de Grupo Camiones Selectos* en Misión Control (Camiones Selectos, Reporte Financiero, NAO/SharePoint, META Leasing y Taller/Manifiesto).",
          "• *Registro directo con folio*: cuando compartas un link de NAO o pidas un ajuste, queda creado en ese segundo en el tablero real de ingeniería.",
          "• *Lenguaje ejecutivo y al grano*: respuestas de 3 a 5 líneas con el estado verificado.",
          "",
          "1. Estado proyectos: ver qué está en verificación y en curso hoy en Camiones Selectos.",
          "2. Reporte y NAO: revisar pendientes de Cartera, Plan Piso, Reporte Financiero o minutas M365.",
          "3. Registrar ajuste: dar de alta un requerimiento o link de NAO directo en Misión Control."
        ].join("\n"),
        learned_tags: ["beta-aceptada", "onboarding-activo", "estilo-ejecutivo-cfo"],
        learned_preference: "Ejecutivo CFO: respuestas de 3 a 5 líneas al grano, sin mensajes largos ni acuses vacíos.",
        capture_piece: null
      };
    }
    if (isJoseRamon) {
      return {
        reply: [
          "¡Qué gusto saludarte, José Ramón! 🚀 Bienvenido al laboratorio beta de Alekito para **KonfortHome**.",
          "",
          "Desde aquí puedes consultar el avance de tus proyectos de KonfortHome en Misión Control, pedirme nuevos encargos o abrir proyectos nuevos, y estructurar *NexusField Pro*.",
          "",
          "1. Mis proyectos: ver qué tenemos activo y en verificación hoy.",
          "2. Pedir encargo o proyecto: registrar una mejora, requerimiento o abrir un nuevo proyecto.",
          "3. NexusField Pro SaaS: avanzar en la propuesta de valor y empaquetado en la nube."
        ].join("\n"),
        learned_tags: ["beta-aceptada", "onboarding-activo"],
        learned_preference: "Aceptó invitación beta de Alekito.",
        capture_piece: null
      };
    }
    return {
      reply: buildDynamicBetaWelcome({
        tags,
        hasMissionProject: Boolean(liveProjects?.length) || tags.includes('cliente-activo'),
        hasNexusAccount: tags.includes('en-nexus')
      }),
      learned_tags: ["beta-aceptada", "onboarding-activo"],
      learned_preference: "Aceptó invitación beta.",
      capture_piece: null
    };
  }

  if (/^ahora no$/i.test(effectiveText.trim())) {
    return {
      reply: `Entendido, ${firstName}. No te enviaré mensajes de prueba por ahora; cuando quieras activarlo, escríbeme por aquí con toda confianza.`,
      learned_tags: ["beta-pospuesta"],
      learned_preference: "Pospuso inicio de prueba beta.",
      capture_piece: null
    };
  }

  const histText = (historyRows || [])
    .slice(-10)
    .map(h => {
      let b = String(h.media_lectura || h.message_body || '').replace(/^\s*\{\s*"reply"\s*:\s*"/i, '').replace(/"\s*,\s*"learned_tags"[\s\S]*$/i, '').replace(/Voy a (?:transcribirlo|procesar[^.]*)[^.]*\./gi, '').replace(/\s+/g, ' ').trim();
      return `${h.direction === 'incoming' ? firstName : 'Alekito'}: ${b}`;
    })
    .join('\n');

  const projectsSummary = Array.isArray(liveProjects) && liveProjects.length
    ? liveProjects.map(lp => {
        const estadoLegible = { 'en-atencion': 'En curso', 'en-verificacion': 'Listo en revisión', 'abierto': 'Pendiente', 'bloqueado': 'En espera', 'hecho': 'Completado', 'resuelto': 'Completado' };
        const pList = (lp.piezas || []).map((p, i) => `    ${i + 1}. ${p.titulo} — *${estadoLegible[p.estado] || p.estado}*`).join('\n');
        return `  • Proyecto **${lp.proyecto?.titulo}** (${lp.proyecto?.id}):\n${pList || '    (Sin piezas aún)'}`;
      }).join('\n')
    : '  (Sin proyectos listados)';

  let calendarBlock = '';
  if (/(?:agenda|reuni[oó]n|videollamada|zoom|llamada|horario|disponib|cu[aá]ndo nos|conectarnos)/i.test(effectiveText)) {
    const avail = await checkCalendarAvailability({ day: /hoy/i.test(effectiveText) ? 'today' : 'tomorrow', contactNumber: contact?.contact_number, contactName: contact?.name });
    if (avail && Array.isArray(avail.slots) && avail.slots.length) {
      const slotList = avail.slots.slice(0, 5).map(s => `${s.title} (${s.description})`).join(', ');
      calendarBlock = `DISPONIBILIDAD REAL EN GOOGLE CALENDAR DE ALEK PARA ${avail.date} (${avail.tz}): Horarios libres de 1 hora: ${slotList}. Ofrece hasta 3 de estos horarios reales para agendar la sesión por Zoom.`;
    }
  }
  const memoryBlock = canonicalMemory?.relevant_memories?.length
    ? [
        "MEMORIA CANÓNICA HISTÓRICA DEL CONTACTO (ACL VERIFICADO):",
        ...(canonicalMemory.profile_facts || []).map(f => `- ${f}`),
        ...canonicalMemory.relevant_memories.map(m => `  • ${m}`)
      ].join('\n')
    : '';

  const accountContext = isAndres
    ? [
        "CONTEXTO DE GRUPO CAMIONES SELECTOS EN NEXUS Y MISIÓN CONTROL:",
        "- Persona: Andrés Valencia (`per-andres-valencia`, Director de Finanzas y Administración / CFO y Champion en Grupo Camiones Selectos).",
        "- REGLA DE ORO CON ANDRÉS (LENGUAJE EJECUTIVO CFO): Andrés detesta los mensajes largos, el relleno y las promesas vacías («anotado, no te dejo en visto» o «ya se lo pasé al equipo técnico»). Sé directo, ejecutivo y conciso: **máximo 1 a 2 párrafos cortos (4 a 6 líneas en total)** o viñetas puntuales con IDs reales (`[enc-...]`) y estados verificados (`en-verificacion`, `en-atencion`, `abierto`).",
        CAMIONES_SELECTOS_FULL_DNA,
        "- Agente Especialista en Procesos de Taller y Postventa IA (activo para Walter Durán / Av. Vallarta):",
        WORK_SPEC_PROMPT,
        "- Proyectos en Misión Control:",
        projectsSummary,
        "- Frentes clave de Andrés: (1) Cartera y Cobranza Operativa (prefijos UNN, SVR, REF; alerta desde 15 días de atraso sobre crédito TOTVS; notas de compromiso de pago); (2) Inventario sin movimiento y márgenes (camiones >30d costo financiero, margen 10%; refacciones margen 30%; taller revisión 45-60d, crítico 90d, margen 100%); (3) Integración NAO / SharePoint / M365 (minutas de reuniones en 5 renglones + decisiones + compromisos con fecha + temas abiertos, tablero Mendel y Carga Inteligente); (4) META Leasing y Plan Piso; (5) Días de detención en Taller y garantías."
      ].join('\n')
    : isJoseRamon
    ? [
        "CONTEXTO DE KONFORTHOME Y NEXUSFIELD PRO EN NEXUS, MISIÓN CONTROL Y GITHUB:",
        "- Persona: José Ramón Reyes Vázquez (`per-jose-ramon-reyes`, Director General de KonfortHome, creador de *NexusField Pro* `pry-kh-nexus`).",
        "- Estilo que José Ramón ya eligió: **Platicado y por voz, trato cercano como entre socios, claro, conciso (2 párrafos cortos, sin rodeos ni relleno) y aterrizado en su negocio real**.",
        KONFORTHOME_GITHUB_DNA,
        "- Proyectos activos de José Ramón en Misión Control:",
        projectsSummary
      ].join('\n')
    : [
        "CONTEXTO DE LA PERSONA:",
        `- Nombre: ${contact?.name || 'Contacto'} (${contactRef})`,
        projectsSummary
      ].join('\n');

  const prompt = [
    "Eres Alekito, el asistente de inteligencia artificial de DIAPAZO.",
    isAndres
      ? "Habla en español de México con tono EJECUTIVO Y SIN PAJA: usa viñetas concretas de 1 renglón cada una. Si Andrés pide un resumen de todos los puntos o proyectos, pon TODOS los puntos concretos en viñetas resumidas de 1 renglón (aunque sean 10 o 12 viñetas, nunca omitas frentes por resumir de más)."
      : "Habla en español de México con tono cercano como entre socios, claro y bien redactado (2 párrafos breves, NUNCA dejes frases a medias ni devuelvas JSON).",
    "",
    accountContext,
    memoryBlock ? "\n" + memoryBlock : "",
    calendarBlock ? "\n" + calendarBlock : "",
    "",
    "REGLAS ESTRICTAS DE RESPUESTA:",
    `1. Escribe ÚNICAMENTE el mensaje que verá ${firstName} en WhatsApp (texto plano con formato ligero de WhatsApp como *negritas*, PROHIBIDO devolver JSON o llaves \`{}\`).`,
    "2. Si el mensaje trae `[transcripción de su nota de voz]` o `[Nota de voz]`, el audio YA ESTÁ TRANSCRITO: responde directo al contenido y NUNCA digas «voy a transcribirlo» ni «voy a procesarlo».",
    "3. ESTADO DE ACCESO A LA UI WEB: El usuario YA tiene activo este WhatsApp con conexión directa a Misión Control, pero TODAVÍA NO tiene activada su cuenta web para abrir `diapazo.com/nexus/mision/`. Por lo tanto: PROHIBIDO inventar enlaces, PROHIBIDO escribir `[Enlace...]` o `[Link...]`, y PROHIBIDO mandar URLs de `diapazo.com/nexus/mision/`. Cita los IDs reales de proyecto/pieza (`pry-...`, `enc-...`) y el estado real.",
    "",
    "HISTORIAL RECIENTE:",
    histText || "(Primeros mensajes)",
    "",
    quotedText ? `MENSAJE AL QUE RESPONDE: «${quotedText}»` : "",
    `MENSAJE ACTUAL DE ${firstName.toUpperCase()}: ${effectiveText}`
  ].filter(Boolean).join("\n");

  try {
    const res = await fetch(N8N_CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tipo: 'chat', contexto: prompt }),
      signal: AbortSignal.timeout(25000)
    });
    if (res.ok) {
      const data = await res.json();
      let clean = String(data?.texto || '').trim();
      clean = clean
        .replace(/^```(?:json|text|markdown)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .replace(/^\s*\{\s*"reply"\s*:\s*"/i, '')
        .replace(/"\s*,\s*"learned_tags"[\s\S]*$/i, '')
        .replace(/"\s*\}\s*$/, '')
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .trim();

      if (clean.length > 10) {
        let cap = null;
        if (/(?:registra|agrega|crea|abre|anota|quiero pedir|nuevo encargo|necesito que|ap[oó]yame|ajust[ea]|csdata\.geekstudio\.dev)/i.test(effectiveText) && effectiveText.length > 12) {
          if (isAndres) {
            cap = {
              company_name: 'Grupo Camiones Selectos',
              target_project: pickCamionesSelectosProject(effectiveText),
              also_alekito: /alekito|bot|whatsapp/i.test(effectiveText),
              tipo: 'encargo',
              texto: effectiveText
            };
          } else if (isJoseRamon) {
            const isAlekitoFeedback = /alekito|bot|whatsapp|voz|botones|estilo/i.test(effectiveText);
            const isSaaS = /nexusfield|saas|nube|licencia|centroam[eé]rica|propuesta de valor/i.test(effectiveText);
            cap = {
              company_name: 'KonfortHome',
              target_project: isAlekitoFeedback ? 'Piloto Beta' : (isSaaS ? 'NexusField Pro' : 'KonfortHome'),
              also_alekito: isAlekitoFeedback,
              tipo: 'encargo',
              texto: effectiveText
            };
          }
        }
        return {
          reply: clean,
          learned_tags: inferTagFromChoice(effectiveText),
          learned_preference: '',
          capture_piece: cap
        };
      }
    }
  } catch (e) {
    console.error('[alekito-universal-llm] error:', e.message);
  }

  return {
    reply: buildDynamicBetaWelcome({ tags, hasMissionProject: isJoseRamon || isAndres || tags.includes('cliente-activo'), hasNexusAccount: true }),
    learned_tags: [],
    learned_preference: '',
    capture_piece: null
  };
}

async function handleUniversalAlekitoInbound(record) {
  if (process.env.ALEKITO_DEPRECATE_LEGACY_IA360 === '0') return false;
  if (!record || record.direction !== 'incoming') return false;
  const isOwnerMsg = digits(record.contact_number) === digits(OWNER_WA);

  try {
    const telemetry = await recordContactEngagement(pool, record).catch(() => null);

    let effectiveText = String(record.message_body || '').trim();
    const tipo = tipoDeLectura(record.message_type);
    if (tipo) {
      const lectura = tipo === 'documento'
        ? await leerDocumento({ record }).catch(() => ({ ok: false, tipo: 'documento' }))
        : await leerMedio({ record, contexto: 'Usuario conversando con Alekito (DIAPAZO)' }).catch(() => ({ ok: false, tipo }));
      const comp = componerMensajeConLectura({ record, lectura });
      if (comp) effectiveText = comp;
    }

    let quotedText = '';
    if (record.context_message_id) {
      const { rows: pRows } = await pool.query(
        "SELECT message_body, media_lectura FROM coexistence.chat_history WHERE message_id = $1 LIMIT 1",
        [record.context_message_id]
      ).catch(() => ({ rows: [] }));
      if (pRows[0]) {
        quotedText = String(pRows[0].message_body || pRows[0].media_lectura || '').replace(/\s+/g, ' ').trim().slice(0, 300);
      }
    }

    const { rows: cRows } = await pool.query(
      "SELECT id, contact_number, COALESCE(name, profile_name) AS name, tags, custom_fields FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = $2 LIMIT 1",
      [record.wa_number, record.contact_number]
    );
    const contact = cRows[0] || { contact_number: record.contact_number, name: record.contact_name || '', tags: [], custom_fields: {} };
    const contactRef = P.contactRef(record.wa_number, record.contact_number);
    const currentTags = Array.isArray(contact.tags) ? contact.tags : (telemetry?.tags || []);
    const knownAccount = resolveKnownAccount(contact.contact_number);

    if (/^s[ií],?\s*quiero probar$/i.test(effectiveText)) {
      await pool.query(
        `INSERT INTO coexistence.alekito_beta_memberships
          (account_ref, contact_ref, program, state, event_at, last_receipt_ref, invitation_request_id)
         VALUES ($1, $2, 'alekito-beta-v1', 'accepted', NOW(), $3, $4)
         ON CONFLICT (account_ref, contact_ref, program)
         DO UPDATE SET state = 'accepted', event_at = NOW(), last_receipt_ref = EXCLUDED.last_receipt_ref, updated_at = NOW()`,
        [P.hash(digits(record.wa_number)).slice(0, 12), contactRef, 'bc_' + Date.now(), 'alekito-beta-' + contactRef]
      ).catch(() => {});
    }


    // ── FLUJO GUIADO DE CALENDARIO Y ZOOM (v73: Compacto, Botones + Lista Interactiva por Día) ──
    const cf = (contact.custom_fields && typeof contact.custom_fields === 'object') ? { ...contact.custom_fields } : {};
    const firstNameCal = String(contact.name || '').trim().split(/\s+/)[0] || 'amigo';
    const rawInteractiveId = (() => {
      try {
        const p = typeof record.raw_payload === 'string' ? JSON.parse(record.raw_payload) : record.raw_payload;
        const m = p?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.interactive;
        return m?.button_reply?.id || m?.list_reply?.id || '';
      } catch { return ''; }
    })();

    const markOwnerHandledIfNeeded = async () => {
      if (isOwnerMsg && record.message_id) {
        const mRef = 'msg_' + P.hash(record.message_id);
        await pool.query("UPDATE coexistence.alekito_inbound_ownership SET dispatch_state = 'completed', error_code = NULL, updated_at = NOW() WHERE message_ref = $1", [mRef]).catch(() => {});
      }
    };

    // Caso D0: El dueño (Alek) autoriza Búnker (Confianza) o elige El Palmar para un contacto que pidió Ocotlán
    if (isOwnerMsg && /^cal_auth_(bunker|palmar)_(\d+)$/.test(rawInteractiveId)) {
      await markOwnerHandledIfNeeded();
      const [, decision, targetPhone] = /^cal_auth_(bunker|palmar)_(\d+)$/.exec(rawInteractiveId);
      const { rows: tRows } = await pool.query("SELECT * FROM coexistence.contacts WHERE contact_number = $1 LIMIT 1", [targetPhone]);
      const tContact = tRows[0];
      if (tContact) {
        const tCf = (tContact.custom_fields && typeof tContact.custom_fields === 'object') ? { ...tContact.custom_fields } : {};
        const tTags = Array.isArray(tContact.tags) ? [...tContact.tags] : [];
        let venueLabel = 'Restaurante El Palmar · Ocotlán, Jal.';
        if (decision === 'bunker') {
          if (!tTags.includes('confianza')) tTags.push('confianza');
          venueLabel = 'Búnker DIAPAZO (Domicilio de Alek) · Ocotlán, Jal.';
        }
        if (tCf.last_booked_slot) tCf.last_booked_slot.location = venueLabel;
        await pool.query("UPDATE coexistence.contacts SET tags = $1::jsonb, custom_fields = $2::jsonb, updated_at = NOW() WHERE id = $3", [JSON.stringify(tTags), JSON.stringify(tCf), tContact.id]);
        const addCalUrl = buildGoogleCalendarTemplateUrl({
          summary: `${tCf.last_booked_slot?.summary || 'Cita Presencial'} (${venueLabel})`,
          startIso: tCf.last_booked_slot?.start || new Date().toISOString(),
          endIso: tCf.last_booked_slot?.end || new Date(Date.now() + 3600000).toISOString(),
          description: `Cita presencial con Alek en Ocotlán: ${venueLabel}`,
          location: venueLabel
        });
        const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
        const msgToContact = [
          `📍 *Lugar confirmado en Ocotlán: ${venueLabel}*`,
          `• *Horario:* ${tCf.last_booked_slot?.label || 'Confirmado'}`,
          "🚗 _Recuerda contemplar ~1h 15m de traslado desde Guadalajara._",
          "",
          `📅 *Guardar en tu calendario:*\n${addCalUrl}`
        ].join("\n");
        const idC = await insertPendingRow({ account, toNumber: targetPhone, messageType: 'text', messageBody: msgToContact, templateMeta: { origin: 'alekito-ocotlan-authorized-v81' } });
        await enqueueSend({ kind: 'text', accountId: account.id, to: targetPhone, localMessageId: idC, payload: { body: msgToContact, previewUrl: true } });

        const msgToOwner = decision === 'bunker'
          ? `✅ *Autorizado Búnker DIAPAZO para ${tContact.name || targetPhone}* (quedó etiquetado como *confianza* y ya recibió la confirmación).`
          : `✅ *Citado en Restaurante El Palmar (Ocotlán) para ${tContact.name || targetPhone}* (sin compartir tu domicilio).`;
        const idO = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: msgToOwner, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-ocotlan-owner-ack-v81' } });
        await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: idO, payload: { body: msgToOwner, previewUrl: false, contextMessageId: record.message_id || null } });
        return true;
      }
    }

    // Caso D1: El contacto envía su Pin de Ubicación de WhatsApp (message_type === 'location') o su dirección cuando eligió "1. En tu oficina"
    const isLocationPin = record.message_type === 'location';
    if (cf.awaiting_office_location && cf.last_booked_slot?.start && (isLocationPin || (effectiveText.length >= 8 && !/^(?:1|2|3)\b/.test(effectiveText)))) {
      await markOwnerHandledIfNeeded();
      let locString = effectiveText.trim();
      if (isLocationPin) {
        const p = typeof record.raw_payload === 'string' ? JSON.parse(record.raw_payload) : record.raw_payload;
        const loc = p?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.location || {};
        const mapsUrl = loc.latitude && loc.longitude ? `https://maps.google.com/?q=${loc.latitude},${loc.longitude}` : '';
        locString = [loc.name, loc.address, mapsUrl].filter(Boolean).join(' · ') || `Pin GPS (${loc.latitude}, ${loc.longitude})`;
      }
      delete cf.awaiting_office_location;
      cf.last_booked_slot.location = locString;
      cf.calendar_flow_closed_at = Date.now();
      if (contact.id) {
        await pool.query("UPDATE coexistence.contacts SET custom_fields = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(cf), contact.id]).catch(() => {});
      }
      // Update the event in Alek's Google Calendar with the client's office location!
      await bookCalendarZoomSlot({
        start: cf.last_booked_slot.start,
        end: cf.last_booked_slot.end,
        modality: 'presencial',
        summary: `Cita Presencial · Alek ↔ ${contact.name || firstNameCal}`,
        description: `Ubicación enviada por ${contact.name || firstNameCal}: ${locString}`,
        location: locString,
        contactNumber: contact.contact_number,
        contactName: contact.name || firstNameCal
      }).catch(() => null);

      const addCalUrl = buildGoogleCalendarTemplateUrl({
        summary: `Cita Presencial · Alek ↔ ${contact.name || firstNameCal}`,
        startIso: cf.last_booked_slot.start,
        endIso: cf.last_booked_slot.end,
        description: `Ubicación: ${locString}`,
        location: locString
      });
      const pinConfirm = [
        `📍 *Ubicación guardada en la cita:* ${locString}`,
        `• *Horario:* ${cf.last_booked_slot.label}`,
        "",
        `📅 *Guardar en tu calendario:*\n${addCalUrl}`
      ].join("\n");
      const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
      const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: pinConfirm, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-office-pin-saved-v81' } });
      await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { body: pinConfirm, previewUrl: true, contextMessageId: record.message_id || null } });
      return true;
    }

    // Caso D2: El contacto de confianza elige entre 1. Búnker DIAPAZO o 2. Restaurante El Palmar en Ocotlán
    if ((rawInteractiveId === 'cal_ocotlan_bunker' || rawInteractiveId === 'cal_ocotlan_palmar') && cf.last_booked_slot?.start) {
      await markOwnerHandledIfNeeded();
      const venueLabel = rawInteractiveId === 'cal_ocotlan_bunker'
        ? 'Búnker DIAPAZO (Domicilio de Alek) · Ocotlán, Jal.'
        : 'Restaurante El Palmar · Ocotlán, Jal.';
      cf.last_booked_slot.location = venueLabel;
      cf.calendar_flow_closed_at = Date.now();
      if (contact.id) {
        await pool.query("UPDATE coexistence.contacts SET custom_fields = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(cf), contact.id]).catch(() => {});
      }
      const addCalUrl = buildGoogleCalendarTemplateUrl({
        summary: `Cita Presencial Ocotlán · Alek ↔ ${contact.name || firstNameCal}`,
        startIso: cf.last_booked_slot.start,
        endIso: cf.last_booked_slot.end,
        description: `Lugar en Ocotlán: ${venueLabel} (~1h 15m desde Guadalajara)`,
        location: venueLabel
      });
      const ocoMsg = [
        `📍 *Cita confirmada en Ocotlán: ${venueLabel}*`,
        `• *Horario:* ${cf.last_booked_slot.label}`,
        "🚗 _Recuerda contemplar ~1h 15m de traslado desde Guadalajara._",
        "",
        `📅 *Guardar en tu calendario:*\n${addCalUrl}`
      ].join("\n");
      const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
      const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: ocoMsg, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-ocotlan-confirmed-v81' } });
      await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { body: ocoMsg, previewUrl: true, contextMessageId: record.message_id || null } });
      return true;
    }

    // Caso D3: El usuario elige dónde verse en cita presencial (1. En tu oficina | 2. Visitar en Ocotlán | 3. Café en GDL)
    const choosesVenueOficina = rawInteractiveId === 'cal_venue_oficina' || (effectiveText.trim().length <= 28 && /^(?:1[.)]?\s*)?(?:en\s+)?(?:tu|mi)\s+oficina$/i.test(effectiveText.trim()));
    const choosesVenueOcotlan = rawInteractiveId === 'cal_venue_ocotlan' || rawInteractiveId === 'cal_venue_diapazo' || (effectiveText.trim().length <= 28 && /(?:ocotl[aá]n|b[uú]nker|oficina\s+diapazo)/i.test(effectiveText.trim()));
    const choosesVenueCafe = rawInteractiveId === 'cal_venue_cafe' || (effectiveText.trim().length <= 28 && /^(?:2[.)]?\s*|3[.)]?\s*)?(?:en\s+un\s+|punto\s+intermedio\s*\/?\s*)?caf[eé](?:\s+en\s+gdl)?$/i.test(effectiveText.trim()));

    if ((choosesVenueOficina || choosesVenueOcotlan || choosesVenueCafe) && cf.last_booked_slot?.start) {
      await markOwnerHandledIfNeeded();
      const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });

      if (choosesVenueOficina) {
        cf.awaiting_office_location = true;
        if (contact.id) {
          await pool.query("UPDATE coexistence.contacts SET custom_fields = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(cf), contact.id]).catch(() => {});
        }
        const askPinMsg = [
          `🏢 *Perfecto, ${firstNameCal}, nos vemos en tu oficina.*`,
          "📍 Mándame por aquí el *pin de ubicación de WhatsApp* (o escribe el domicilio) para dejarlo guardado directo en la cita del calendario."
        ].join("\n");
        const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: askPinMsg, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-ask-office-pin-v81' } });
        await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { body: askPinMsg, previewUrl: false, contextMessageId: record.message_id || null } });
        return true;
      }

      if (choosesVenueOcotlan) {
        const isTrusted = currentTags.includes('confianza') || currentTags.includes('de-confianza') || digits(contact.contact_number).endsWith('3319706935') || isOwnerMsg;
        if (isTrusted) {
          const ocoBody = [
            "🏡 *Visita a Alek en Ocotlán, Jal.* (~1h 15m desde Guadalajara)",
            "Como eres socio de confianza, elige dónde prefieres que nos veamos en Ocotlán:"
          ].join("\n");
          const ocoBtns = {
            type: 'button',
            header: { type: 'text', text: '📍 Sede en Ocotlán' },
            body: { text: ocoBody },
            footer: { text: 'Toca una opción' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: 'cal_ocotlan_bunker', title: '1. Búnker DIAPAZO' } },
                { type: 'reply', reply: { id: 'cal_ocotlan_palmar', title: '2. Rest. El Palmar' } }
              ]
            }
          };
          const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'interactive', messageBody: ocoBody, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-ocotlan-trusted-v81', interactive_type: 'button', options: [{ id: 'cal_ocotlan_bunker', title: '1. Búnker DIAPAZO' }, { id: 'cal_ocotlan_palmar', title: '2. Rest. El Palmar' }] } });
          await enqueueSend({ kind: 'interactive', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { interactive: ocoBtns, contextMessageId: record.message_id || null } });
          return true;
        } else {
          // Contact does NOT have 'confianza' tag -> notify contact and send authorization buttons to Alek!
          const waitMsg = [
            "🚗 *Nota:* Alek se encuentra en *Ocotlán, Jal.* (~1h 15m desde Guadalajara).",
            "Le acabo de enviar tu solicitud para que me confirme si nos vemos en el *Restaurante El Palmar* o en el *Búnker de DIAPAZO* y te comparto la ubicación exacta enseguida."
          ].join("\n");
          const idWait = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: waitMsg, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-ocotlan-pending-auth-v81' } });
          await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: idWait, payload: { body: waitMsg, previewUrl: false, contextMessageId: record.message_id || null } });

          const cleanDigits = digits(contact.contact_number);
          const authBody = [
            `🔐 *Solicitud de cita en Ocotlán: ${contact.name || cleanDigits}*`,
            `• *Horario:* ${cf.last_booked_slot.label}`,
            "Este contacto aún no tiene la etiqueta *confianza*. ¿Le compartimos ubicación del *Búnker* (y lo marcamos de confianza) o lo citamos en *El Palmar*?"
          ].join("\n");
          const authBtns = {
            type: 'button',
            header: { type: 'text', text: '🔐 Autorizar sede Ocotlán' },
            body: { text: authBody },
            footer: { text: 'Toca para autorizar y responderle' },
            action: {
              buttons: [
                { type: 'reply', reply: { id: `cal_auth_bunker_${cleanDigits}`, title: '1. Autorizar Búnker' } },
                { type: 'reply', reply: { id: `cal_auth_palmar_${cleanDigits}`, title: '2. Citar El Palmar' } }
              ]
            }
          };
          const idAuth = await insertPendingRow({ account, toNumber: OWNER_WA, messageType: 'interactive', messageBody: authBody, templateMeta: { origin: 'alekito-owner-ocotlan-auth-v81', interactive_type: 'button' } });
          await enqueueSend({ kind: 'interactive', accountId: account.id, to: OWNER_WA, localMessageId: idAuth, payload: { interactive: authBtns } });
          return true;
        }
      }

      // Café en Guadalajara
      const venueLabel = 'Café / Punto intermedio en Guadalajara';
      cf.last_booked_slot.location = venueLabel;
      cf.calendar_flow_closed_at = Date.now();
      if (contact.id) {
        await pool.query("UPDATE coexistence.contacts SET custom_fields = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(cf), contact.id]).catch(() => {});
      }
      const addCalUrl = buildGoogleCalendarTemplateUrl({
        summary: `${cf.last_booked_slot.summary || 'Cita Presencial'} (${venueLabel})`,
        startIso: cf.last_booked_slot.start,
        endIso: cf.last_booked_slot.end,
        description: `Cita presencial con Alek en: ${venueLabel}`,
        location: venueLabel
      });
      const venueMsg = [
        `📍 *Lugar confirmado: ${venueLabel}*`,
        `• *Horario:* ${cf.last_booked_slot.label}`,
        "",
        `📅 *Guardar en tu calendario:*\n${addCalUrl}`
      ].join("\n");
      const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: venueMsg, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-calendar-venue-v81', venue: venueLabel } });
      await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { body: venueMsg, previewUrl: true, contextMessageId: record.message_id || null } });
      return true;
    }

    // Caso C: El usuario escribe su correo tras agendar
    const emailMatch = /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/.exec(effectiveText);
    if (emailMatch && cf.awaiting_calendar_email && cf.last_booked_slot?.start) {
      await markOwnerHandledIfNeeded();
      const userEmail = emailMatch[1].toLowerCase();
      cf.email = userEmail;
      delete cf.awaiting_calendar_email;
      const last = cf.last_booked_slot;
      // Re-run booking or add attendee in Google Calendar
      await bookCalendarZoomSlot({
        start: last.start,
        end: last.end,
        modality: last.modality || 'zoom',
        summary: last.summary,
        location: last.location || '',
        email: userEmail,
        contactNumber: contact.contact_number,
        contactName: contact.name || firstNameCal
      }).catch(() => null);
      if (contact.id) {
        await pool.query("UPDATE coexistence.contacts SET custom_fields = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(cf), contact.id]).catch(() => {});
      }
      const emailMsg = `✉️ *Invitación enviada a ${userEmail}*\nYa quedó agregada a tu correo con todos los datos de la sesión.`;
      const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
      const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: emailMsg, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-calendar-email-v73' } });
      await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { body: emailMsg, previewUrl: false, contextMessageId: record.message_id || null } });
      return true;
    }

    // Caso B: El usuario elige un horario del menú interactivo (slot_... o opt_...)
    let chosenSlot = null;
    if (Array.isArray(cf.pending_calendar_slots) && cf.pending_calendar_slots.length > 0) {
      if (rawInteractiveId.startsWith('slot_')) {
        chosenSlot = cf.pending_calendar_slots.find(s => s.id === rawInteractiveId);
      }
      if (!chosenSlot) {
        chosenSlot = cf.pending_calendar_slots.find(s =>
          effectiveText.toLowerCase().includes(String(s.title || '').toLowerCase()) ||
          (s.dayLabel && s.hora && effectiveText.toLowerCase().includes(s.dayLabel.toLowerCase()) && effectiveText.includes(s.hora))
        );
      }
    }

    if (chosenSlot) {
      await markOwnerHandledIfNeeded();
      const modality = cf.pending_calendar_modality || 'zoom';
      const contactEmail = cf.email || '';
      const summary = modality === 'presencial'
        ? `Cita Presencial · Alek ↔ ${contact.name || firstNameCal}`
        : `Sesión Zoom · Alek ↔ ${contact.name || firstNameCal}`;
      const booked = await bookCalendarZoomSlot({
        start: chosenSlot.start,
        end: chosenSlot.end,
        modality,
        summary,
        location: modality === 'presencial' ? 'Guadalajara (sede por confirmar)' : '',
        email: contactEmail,
        contactNumber: contact.contact_number,
        contactName: contact.name || firstNameCal
      });
      const zoomUrl = booked?.zoomJoinUrl || '';
      const addCalUrl = buildGoogleCalendarTemplateUrl({
        summary,
        startIso: chosenSlot.start,
        endIso: chosenSlot.end,
        description: zoomUrl ? `Entrar a Zoom: ${zoomUrl}` : 'Cita presencial con Alek',
        location: zoomUrl || (modality === 'presencial' ? 'Guadalajara' : '')
      });
      cf.last_booked_slot = {
        start: chosenSlot.start,
        end: chosenSlot.end,
        label: `${chosenSlot.title} (${chosenSlot.description})`,
        modality,
        summary,
        zoomJoinUrl: zoomUrl,
        calendarEventId: booked?.calendarEventId || null,
        location: modality === 'presencial' ? 'Guadalajara' : ''
      };
      delete cf.pending_calendar_slots;
      cf.awaiting_calendar_email = !contactEmail;
      if (contact.id) {
        await pool.query("UPDATE coexistence.contacts SET custom_fields = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(cf), contact.id]).catch(() => {});
      }
      const confirmMsg = [
        `✅ *Cita confirmada: ${chosenSlot.title} (${chosenSlot.description})*`,
        "",
        ...(modality === 'zoom' && zoomUrl
          ? [`🎥 *Entrar a Zoom:*\n${zoomUrl}`, ""]
          : [`📍 *Modalidad:* Presencial en Guadalajara`, ""]),
        `📅 *Guardar en tu calendario:*\n${addCalUrl}`,
        "",
        contactEmail
          ? `✉️ _Invitación enviada a ${contactEmail}._`
          : `✉️ _Si quieres la invitación en tu correo, escríbeme tu email._`
      ].join("\n");
      const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
      if (modality === 'presencial') {
        const presVenueBody = [
          `✅ *Horario reservado: ${chosenSlot.title} (${chosenSlot.description})*`,
          "",
          "📍 *¿Dónde prefieres que nos reunamos?*",
          "Elige una opción para incluir la ubicación en tu invitación de calendario:"
        ].join("\n");
        const venueBtns = {
          type: 'button',
          header: { type: 'text', text: '📍 Elegir lugar de reunión' },
          body: { text: presVenueBody },
          footer: { text: 'Toca dónde vernos' },
          action: {
            buttons: [
              { type: 'reply', reply: { id: 'cal_venue_oficina', title: '1. En tu oficina' } },
              { type: 'reply', reply: { id: 'cal_venue_ocotlan', title: '2. Ir a Ocotlán' } },
              { type: 'reply', reply: { id: 'cal_venue_cafe', title: '3. Café en GDL' } }
            ]
          }
        };
        const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'interactive', messageBody: presVenueBody, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-calendar-booked-presencial-v79', booking: cf.last_booked_slot, interactive_type: 'button', options: [{ id: 'cal_venue_oficina', title: '1. En tu oficina' }, { id: 'cal_venue_cafe', title: '2. En un café' }, { id: 'cal_venue_diapazo', title: '3. Oficina DIAPAZO' }] } });
        await enqueueSend({ kind: 'interactive', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { interactive: venueBtns, contextMessageId: record.message_id || null } });
      } else {
        const localId = await insertPendingRow({ account, toNumber: record.contact_number, messageType: 'text', messageBody: confirmMsg, contextMessageId: record.message_id || null, templateMeta: { origin: 'alekito-calendar-booked-v79', booking: cf.last_booked_slot } });
        await enqueueSend({ kind: 'text', accountId: account.id, to: record.contact_number, localMessageId: localId, payload: { body: confirmMsg, previewUrl: true, contextMessageId: record.message_id || null } });
      }

      // Auto-cleanup test event if this is a beta test, and if José Ramón just tested Zoom, offer the 1-tap button to test Presencial (or vice versa)!
      if (booked?.calendarEventId) {
        setTimeout(() => {
          fetch('http://n8n:5678/webhook/ia360-calendar-cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ calendarEventId: booked.calendarEventId, zoomMeetingId: booked.zoomMeetingId || '' })
          }).catch(() => {});
        }, 8000);
      }

      return true;
    }

    // Caso A: El usuario toca "1. Por Zoom" o "2. Presencial" (o pide agendar)
    const choosesZoom = rawInteractiveId === 'cal_mod_zoom' || (effectiveText.trim().length <= 28 && /^(?:1[.)]?\s*)?(?:reuni[oó]n\s*)?(?:por\s*)?zoom$/i.test(effectiveText.trim()));
    const choosesPresencial = rawInteractiveId === 'cal_mod_presencial' || (effectiveText.trim().length <= 28 && /^(?:2[.)]?\s*)?(?:cita\s*)?presencial$/i.test(effectiveText.trim()));
    const isPastOrMetaBooking = /(?:ya agend[eé]|una vez agendad|revisa eso|varias veces)/i.test(effectiveText);
    const recentlyClosed = cf.calendar_flow_closed_at && (Date.now() - cf.calendar_flow_closed_at < 600000) && !/(?:otra cita|nueva cita|cambiar cita)/i.test(effectiveText);
    const asksToSchedule = !isOwnerMsg && !isPastOrMetaBooking && !recentlyClosed && /(?:quiero agendar|podemos agendar|me agendas|ag[eé]ndame|hacer una cita|programar una cita|cu[aá]ndo nos vemos|cu[aá]ndo nos conectamos)/i.test(effectiveText);
    const ownerStartsTest = isOwnerMsg && /^(?:probar agenda|probar cita|agendar cita)$/i.test(effectiveText);

    if (choosesZoom || choosesPresencial) {
      await markOwnerHandledIfNeeded();
      const modality = choosesPresencial ? 'presencial' : 'zoom';
      const avail = await checkCalendarAvailability({ day: 'this_week', modality, contactNumber: contact.contact_number, contactName: contact.name || firstNameCal });
      const days = Array.isArray(avail?.days) ? avail.days.slice(0, 3) : [];
      const flatSlots = [];
      const sections = [];
      for (const d of days) {
        const rows = [];
        for (const s of (d.slots || []).slice(0, 3)) {
          flatSlots.push(s);
          rows.push({
            id: s.id,
            title: `${d.label} · ${s.hora}`,
            description: `${s.description} (hora CDMX) · ${modality === 'presencial' ? 'Con traslado libre' : 'Sesión Zoom'}`
          });
        }
        if (rows.length) sections.push({ title: `📅 ${d.label} (${d.date})`, rows });
      }
      if (flatSlots.length > 0) {
        cf.pending_calendar_modality = modality;
        cf.pending_calendar_slots = flatSlots;
        if (contact.id) {
          await pool.query("UPDATE coexistence.contacts SET custom_fields = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(cf), contact.id]).catch(() => {});
        }
        const bodyText = modality === 'presencial'
          ? "📍 *Cita presencial en Guadalajara*\nAbre *Elegir horario* para seleccionar el día y hora (ya contempla margen de traslado):"
          : "🎥 *Sesión por Zoom (60 min)*\nAbre *Elegir horario* para seleccionar el día y hora:";
        const interactiveList = {
          type: 'list',
          header: { type: 'text', text: modality === 'presencial' ? '📍 Agenda Presencial' : '🎥 Agenda por Zoom' },
          body: { text: bodyText },
          footer: { text: ' confirmación y links al instante' },
          action: {
            button: 'Elegir horario',
            sections
          }
        };
        const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
        const localId = await insertPendingRow({
          account,
          toNumber: record.contact_number,
          messageType: 'interactive',
          messageBody: bodyText,
          contextMessageId: record.message_id || null,
          templateMeta: {
            origin: 'alekito-calendar-list-v73',
            modality,
            interactive_type: 'list',
            options: flatSlots.map(s => ({ id: s.id, title: s.title }))
          }
        });
        await enqueueSend({
          kind: 'interactive',
          accountId: account.id,
          to: record.contact_number,
          localMessageId: localId,
          payload: { interactive: interactiveList, contextMessageId: record.message_id || null }
        });
        return true;
      }
    } else if (asksToSchedule || ownerStartsTest) {
      await markOwnerHandledIfNeeded();
      const bodyText = "📅 *Agendar sesión con Alek*\n¿Cómo prefieres que nos reunamos?";
      const interactiveBtns = {
        type: 'button',
        header: { type: 'text', text: '📅 Agendar reunión' },
        body: { text: bodyText },
        footer: { text: 'Toca una opción' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'cal_mod_zoom', title: '1. Por Zoom' } },
            { type: 'reply', reply: { id: 'cal_mod_presencial', title: '2. Presencial' } }
          ]
        }
      };
      const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
      const localId = await insertPendingRow({
        account,
        toNumber: record.contact_number,
        messageType: 'interactive',
        messageBody: bodyText,
        contextMessageId: record.message_id || null,
        templateMeta: {
          origin: 'alekito-calendar-modality-v73',
          interactive_type: 'button',
          options: [
            { id: 'cal_mod_zoom', title: '1. Por Zoom' },
            { id: 'cal_mod_presencial', title: '2. Presencial' }
          ]
        }
      });
      await enqueueSend({
        kind: 'interactive',
        accountId: account.id,
        to: record.contact_number,
        localMessageId: localId,
        payload: { interactive: interactiveBtns, contextMessageId: record.message_id || null }
      });
      return true;
    }

    if (isOwnerMsg) return false;

    const isJoseRamon = digits(contact.contact_number).endsWith('3319706935');
    const isAndres = digits(contact.contact_number).endsWith('3321060293');

    const [liveProjects, canonicalMemory, historyRes] = await Promise.all([
      (isJoseRamon || isAndres) ? discoverAndReadContactProjects(contactRef, contact.contact_number) : Promise.resolve([]),
      retrieveCanonicalContactMemory({
        waNumber: record.wa_number,
        contactNumber: contact.contact_number,
        contact,
        queryText: effectiveText,
        knownAccount
      }),
      pool.query(
        "SELECT direction, message_type, message_body, media_lectura, timestamp FROM coexistence.chat_history WHERE wa_number = $1 AND contact_number = $2 AND id <> $3 ORDER BY id DESC LIMIT 12",
        [record.wa_number, record.contact_number, record.id || 0]
      ).catch(() => ({ rows: [] }))
    ]);

    const aiOut = await generateSmartBetaReply({
      contact,
      contactRef,
      effectiveText,
      quotedText,
      tags: currentTags,
      engagementProfile: contact.custom_fields?.engagement_profile || telemetry?.engagement_profile,
      historyRows: (historyRes.rows || []).reverse(),
      liveProjects,
      canonicalMemory
    });

    let finalReplyText = String(aiOut.reply || '')
      .replace(/\s*`?\[(?:enc|ide|cor)-[A-Za-z0-9_-]+\]`?\s*/g, ' ')
      .replace(/\s*\(`?(?:en-atencion|en-verificacion|por_revisar|abierto)`?\)/g, '')
      .replace(/\[(?:Enlace|Link|URL)[^\]]*\]/gi, '')
      .replace(/https?:\/\/diapazo\.com\/nexus\/mision\/[^\s)]+/gi, '')
      .replace(/\s+([.,!])/g, '$1')
      .trim();

    if (aiOut.capture_piece && aiOut.capture_piece.texto && (isJoseRamon || isAndres)) {
      const receipt = await captureContactMissionPiece({
        projectName: aiOut.capture_piece.target_project || (isAndres ? 'Camiones Selectos' : 'KonfortHome'),
        companyName: aiOut.capture_piece.company_name || (isAndres ? 'Grupo Camiones Selectos' : 'KonfortHome'),
        tipo: aiOut.capture_piece.tipo || 'encargo',
        texto: aiOut.capture_piece.texto,
        requesterName: contact.name || knownAccount?.personaNombre || 'Cliente'
      });
      if (aiOut.capture_piece.also_alekito) {
        await captureContactMissionPiece({
          projectName: 'Alekito · diseño e integración ForgeChat',
          companyName: 'Diapazo',
          tipo: 'encargo',
          texto: `[Aprendizaje Beta ${knownAccount?.companyName || ''} - ${contact.name || ''}]: ${aiOut.capture_piece.texto}`,
          requesterName: contact.name || 'Cliente'
        }).catch(() => null);
      }
      if (receipt?.piece_ref) {
        finalReplyText += `\n\n📌 *Registrado en Misión Control:* \`${receipt.piece_ref}\` (${receipt.project_title || aiOut.capture_piece.target_project})`;
      }
    }

    // Punto 2: Inyección asíncrona de hechos/necesidades al expediente de Nexus
    autoInjectInteractionToNexus({
      knownAccount,
      messageId: record.message_id || record.id,
      effectiveText,
      aiReply: finalReplyText
    }).catch(() => null);

    const newInterestTags = [
      ...inferTagFromChoice(effectiveText),
      ...(Array.isArray(aiOut.learned_tags) ? aiOut.learned_tags.map(t => String(t).toLowerCase().trim().replace(/\s+/g, '-')).filter(Boolean) : [])
    ];
    const mergedTags = [...new Set([...currentTags, 'atendido-por-alekito', ...newInterestTags])];
    const updatedFields = (contact.custom_fields && typeof contact.custom_fields === 'object') ? { ...contact.custom_fields } : {};
    if (aiOut.learned_preference) {
      const notes = Array.isArray(updatedFields.communication_preferences) ? updatedFields.communication_preferences : [];
      notes.push({
        note: aiOut.learned_preference.slice(0, 500),
        input_sample: effectiveText.slice(0, 140),
        updated_at: new Date().toISOString(),
        by: 'alekito-beta-learning'
      });
      updatedFields.communication_preferences = notes.slice(-15);
      updatedFields.last_preference_summary = aiOut.learned_preference.slice(0, 500);
    }

    if (contact.id) {
      await pool.query(
        "UPDATE coexistence.contacts SET tags = $1::jsonb, custom_fields = $2::jsonb, updated_at = NOW() WHERE id = $3",
        [JSON.stringify(mergedTags), JSON.stringify(updatedFields), contact.id]
      ).catch(() => {});
    }

    const { account } = await resolveAccount({ fromPhoneNumber: record.wa_number });
    const spec = buildInteractiveFromText(finalReplyText);
    if (spec && spec.interactive) {
      const localId = await insertPendingRow({
        account,
        toNumber: record.contact_number,
        messageType: 'interactive',
        messageBody: spec.formattedText || finalReplyText,
        contextMessageId: record.message_id || null,
        templateMeta: {
          origin: 'alekito-universal-guided-v61',
          interactive_type: 'button',
          options: spec.options,
          learned_tags: newInterestTags
        }
      });
      await enqueueSend({
        kind: 'interactive',
        accountId: account.id,
        to: record.contact_number,
        localMessageId: localId,
        payload: { interactive: spec.interactive, contextMessageId: record.message_id || null }
      });
    } else {
      const localId = await insertPendingRow({
        account,
        toNumber: record.contact_number,
        messageType: 'text',
        messageBody: finalReplyText,
        contextMessageId: record.message_id || null,
        templateMeta: {
          origin: 'alekito-universal-guided-v61',
          learned_tags: newInterestTags
        }
      });
      await enqueueSend({
        kind: 'text',
        accountId: account.id,
        to: record.contact_number,
        localMessageId: localId,
        payload: { body: finalReplyText, previewUrl: false, contextMessageId: record.message_id || null }
      });
    }
    return true;
  } catch (err) {
    console.error('[alekito-universal] error:', err.message);
    return false;
  }
}

// ── PUNTO 3: Vigilante proactivo Misión Control → WhatsApp del cliente ──────────────────────────────────────
let _watcherStarted = false;
async function pollMisionProactiveChanges({ seedOnly = false } = {}) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS coexistence.alekito_mision_piece_watch (
        project_id TEXT NOT NULL,
        piece_id TEXT NOT NULL,
        empresa_id TEXT NOT NULL,
        contact_number TEXT NOT NULL,
        titulo TEXT NOT NULL,
        estado TEXT NOT NULL,
        version INT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notified_at TIMESTAMPTZ,
        PRIMARY KEY (project_id, piece_id)
      )
    `);
    for (const [phoneDigits, info] of Object.entries(KNOWN_BETA_ACCOUNTS)) {
      const projects = await discoverAndReadContactProjects(info.contactRef, phoneDigits);
      const transitions = [];
      for (const lp of projects) {
        const projId = lp.proyecto?.id;
        const projTitle = lp.proyecto?.titulo || projId;
        if (!projId) continue;
        for (const p of (lp.piezas || [])) {
          const { rows: prev } = await pool.query(
            "SELECT estado, version, notified_at FROM coexistence.alekito_mision_piece_watch WHERE project_id = $1 AND piece_id = $2",
            [projId, p.id]
          );
          if (!prev.length) {
            await pool.query(
              `INSERT INTO coexistence.alekito_mision_piece_watch (project_id, piece_id, empresa_id, contact_number, titulo, estado, version, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
              [projId, p.id, info.empresaId, phoneDigits, p.titulo || p.id, p.estado, p.version || 1]
            );
          } else if (prev[0].estado !== p.estado || prev[0].version !== p.version) {
            const oldEstado = prev[0].estado;
            await pool.query(
              "UPDATE coexistence.alekito_mision_piece_watch SET estado = $1, version = $2, titulo = $3, updated_at = NOW() WHERE project_id = $4 AND piece_id = $5",
              [p.estado, p.version || 1, p.titulo || p.id, projId, p.id]
            );
            if (!seedOnly && oldEstado !== p.estado && ['en-verificacion', 'hecho', 'resuelto'].includes(p.estado)) {
              transitions.push({ projId, projTitle, pieceId: p.id, titulo: p.titulo, oldEstado, newEstado: p.estado, version: p.version });
            }
          }
        }
      }
      if (!seedOnly && transitions.length > 0) {
        // Check that the contact has an open 24h window before sending a proactive text
        const { rows: win } = await pool.query(
          "SELECT message_id, timestamp FROM coexistence.chat_history WHERE contact_number = $1 AND direction = 'incoming' AND timestamp > NOW() - INTERVAL '23 hours' ORDER BY id DESC LIMIT 1",
          [phoneDigits]
        );
        if (win.length > 0) {
          const { account } = await resolveAccount({ fromPhoneNumber: '5213321594582' });
          const lines = transitions.slice(0, 3).map(t => `• *[${t.pieceId}]* (${t.projTitle}): pasó a *${t.newEstado === 'en-verificacion' ? 'En verificación' : t.newEstado}* (v${t.version}) — _${t.titulo}_`);
          const notifyBody = [
            `⚡ *Avance en Misión Control (${info.companyName}):*`,
            ...lines
          ].join('\n');
          const localId = await insertPendingRow({
            account,
            toNumber: phoneDigits,
            messageType: 'text',
            messageBody: notifyBody,
            contextMessageId: win[0].message_id || null,
            templateMeta: { origin: 'alekito-mision-proactive-v61', transitions }
          });
          await enqueueSend({
            kind: 'text',
            accountId: account.id,
            to: phoneDigits,
            localMessageId: localId,
            payload: { body: notifyBody, previewUrl: false, contextMessageId: win[0].message_id || null }
          });
          for (const t of transitions) {
            await pool.query("UPDATE coexistence.alekito_mision_piece_watch SET notified_at = NOW() WHERE project_id = $1 AND piece_id = $2", [t.projId, t.pieceId]);
          }
        }
      }
    }
  } catch (e) {
    console.error('[alekito-proactive-watcher] error:', e.message);
  }
}

function startMisionProactiveWatcher() {
  if (_watcherStarted) return;
  _watcherStarted = true;
  setTimeout(() => {
    pollMisionProactiveChanges({ seedOnly: true }).catch(() => {});
    setInterval(() => pollMisionProactiveChanges({ seedOnly: false }).catch(() => {}), 90000);
  }, 5000);
}

startMisionProactiveWatcher();

module.exports = {
  checkCalendarAvailability,
  bookCalendarZoomSlot,
  handleUniversalAlekitoInbound,
  generateSmartBetaReply,
  readContactMissionProject,
  discoverAndReadContactProjects,
  captureContactMissionPiece,
  createMissionProjectForKonfortHome,
  retrieveCanonicalContactMemory,
  autoInjectInteractionToNexus,
  pollMisionProactiveChanges
};
