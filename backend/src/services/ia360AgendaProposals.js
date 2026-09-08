// services/ia360AgendaProposals.js — Módulo puro y orquestador de propuestas de agenda
// durables con confirmación obligatoria del owner (Alek).
//
// CONTRATO Y ARQUITECTURA (2026-09-08):
// 1. Las herramientas del agente (proponer_reunion / cancelar_reunion) NUNCA autorizan
//    escrituras directamente ni pasan un booleano $fromAI.
// 2. En su lugar, llaman a POST /internal/ia360-agenda/propose para emitir una propuesta
//    inmutable con clave única (source_message_id, kind, payload_hash) y estado 'pending'.
// 3. El owner recibe una tarjeta interactiva en WhatsApp con botones estructurados:
//    ia360_agenda_yes:<proposal_id> / ia360_agenda_no:<proposal_id>.
// 4. Al hacer tap, el backend verifica: emisor == IA360_OWNER_NUMBER, misma línea emisora
//    (proposal.wa_number === recordWa), propuesta pending y no expirada (30 min),
//    bloqueo asesor global (pg_try_advisory_lock), reclamo atómico condicional con commit previo a I/O,
//    y ejecuta el writer hacia n8n con Bearer N8N_CALENDAR_TOKEN.
// 5. Exige respuesta verificada del proveedor (ok===true && verified===true + IDs/token/link).
// 6. Los comentarios del owner en tarjetas de fallo se pasan al agente en modo
//    'owner_assistance' con contexto estructurado; NUNCA se reenvían literales ni
//    se usan regexes de frase para asumir autoridad.
'use strict';

const crypto = require('crypto');

const PROPOSAL_EXPIRATION_MINUTES = 30;
const PROPOSAL_STATES = [
  'pending',
  'executing',
  'completed',
  'rejected',
  'expired',
  'failed',
  'execution_uncertain',
  'blocked',
];
const IA360_OWNER_NUMBER = process.env.IA360_OWNER_NUMBER || '5213322638033';
const CALENDAR_ADVISORY_LOCK_ID = 36082026; // ID global estable para operaciones de calendario

const N8N_IA360_OWNER_BOOK_WEBHOOK_URL = process.env.N8N_IA360_OWNER_BOOK_WEBHOOK_URL || 'http://n8n:5678/webhook/ia360-owner-agenda-book';
const N8N_IA360_OWNER_CANCEL_WEBHOOK_URL = process.env.N8N_IA360_OWNER_CANCEL_WEBHOOK_URL || 'http://n8n:5678/webhook/ia360-owner-agenda-cancel';

const ISO_8601_TZ_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function normalizePhone(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

function maskNumber(number) {
  const s = String(number || '');
  if (!s) return 'sin número';
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function formatDateCdMx(isoRaw) {
  if (!isoRaw) return 'la fecha agendada';
  try {
    const d = new Date(isoRaw);
    if (isNaN(d.getTime())) return 'la fecha agendada';
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  } catch (_) {
    return 'la fecha agendada';
  }
}

function formatTimeCdMx(isoRaw) {
  if (!isoRaw) return '';
  try {
    const d = new Date(isoRaw);
    if (isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City',
      timeStyle: 'short',
    }).format(d);
  } catch (_) {
    return '';
  }
}

/**
 * Calcula un hash canónico determinista del payload para deduplicación e idempotencia.
 */
function computePayloadHash({ kind, start_utc, end_utc, title, event_id }) {
  const canonical = kind === 'book'
    ? `book:${start_utc}:${end_utc}:${title || ''}`
    : `cancel:${event_id || ''}`;
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Valida los parámetros de entrada de una propuesta de agenda.
 *
 * @param {object} input
 * @param {object} [opts]
 * @param {boolean} [opts.allowPastDates=false]
 * @returns {{ ok: boolean, errors: string[], sanitized: object }}
 */
function validateProposalInput(input = {}, { allowPastDates = false } = {}) {
  const errors = [];
  const waNumber = normalizePhone(input.wa_number);
  const contactNumber = normalizePhone(input.contact_number);
  const sourceMessageId = input.source_message_id && typeof input.source_message_id === 'string'
    ? input.source_message_id.trim()
    : '';
  const kind = String(input.kind || '').trim().toLowerCase();
  const dryRun = input.dry_run === true || input.dry_run === 'true';

  if (!waNumber) errors.push('wa_number_required');
  if (!contactNumber) errors.push('contact_number_required');
  if (!sourceMessageId) errors.push('source_message_id_required');
  if (!['book', 'cancel'].includes(kind)) errors.push('invalid_kind');

  let startUtc = null;
  let endUtc = null;
  let title = input.title && typeof input.title === 'string'
    ? input.title.trim().slice(0, 200)
    : 'Reunión IA360';
  let eventId = input.event_id && typeof input.event_id === 'string'
    ? input.event_id.trim()
    : null;

  if (kind === 'book') {
    if (typeof input.start_utc !== 'string' || !ISO_8601_TZ_REGEX.test(input.start_utc)) {
      errors.push('start_utc_explicit_iso_required');
    }
    if (typeof input.end_utc !== 'string' || !ISO_8601_TZ_REGEX.test(input.end_utc)) {
      errors.push('end_utc_explicit_iso_required');
    }

    if (errors.length === 0) {
      const start = new Date(input.start_utc);
      const end = new Date(input.end_utc);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        errors.push('invalid_iso_date');
      } else if (!allowPastDates && start.getTime() <= Date.now()) {
        errors.push('start_must_be_in_future');
      } else if (end.getTime() <= start.getTime()) {
        errors.push('end_must_be_after_start');
      } else {
        const durationMs = end.getTime() - start.getTime();
        if (durationMs < 15 * 60 * 1000) errors.push('duration_too_short');
        if (durationMs > 24 * 60 * 60 * 1000) errors.push('duration_too_long');
        startUtc = start.toISOString();
        endUtc = end.toISOString();
      }
    }
  }

  if (kind === 'cancel') {
    if (!eventId) errors.push('event_id_required');
  }

  const payloadHash = errors.length === 0
    ? computePayloadHash({ kind, start_utc: startUtc, end_utc: endUtc, title, event_id: eventId })
    : '';

  return {
    ok: errors.length === 0,
    errors,
    sanitized: {
      wa_number: waNumber,
      contact_number: contactNumber,
      source_message_id: sourceMessageId,
      kind,
      payload_hash: payloadHash,
      start_utc: startUtc,
      end_utc: endUtc,
      title,
      event_id: eventId,
      contact_name: input.contact_name && typeof input.contact_name === 'string' ? input.contact_name.trim() : null,
      dry_run: dryRun,
    },
  };
}

/**
 * Construye los botones estructurados para la tarjeta WhatsApp del owner.
 */
function buildProposalButtons(proposalId, kind) {
  return [
    {
      type: 'reply',
      reply: {
        id: `ia360_agenda_yes:${proposalId}`,
        title: kind === 'cancel' ? 'Sí, cancelar' : 'Sí, agendar',
      },
    },
    {
      type: 'reply',
      reply: {
        id: `ia360_agenda_no:${proposalId}`,
        title: 'No',
      },
    },
  ];
}

/**
 * Formatea el texto de la tarjeta interactiva de propuesta para Alek.
 */
function formatProposalCardText({
  kind,
  startUtc,
  endUtc,
  title,
  contactName,
  contactNumber,
  eventId,
}) {
  const who = contactName || `contacto ${maskNumber(contactNumber)}`;
  if (kind === 'cancel') {
    return [
      'Alek, solicitud de cancelación de cita:',
      '',
      `Contacto: ${who} (${maskNumber(contactNumber)})`,
      `Evento ID: ${eventId || 'sin ID'}`,
      '',
      '¿Autorizas cancelar esta reunión?',
    ].join('\n');
  }

  const startFmt = formatDateCdMx(startUtc);
  const endFmt = formatTimeCdMx(endUtc);
  return [
    'Alek, tengo una propuesta de cita pendiente de confirmación:',
    '',
    `Contacto: ${who} (${maskNumber(contactNumber)})`,
    `Horario: ${startFmt}${endFmt ? ` a ${endFmt}` : ''}`,
    `Título: ${title || 'Reunión IA360'}`,
    '',
    '¿Autorizas agendar esta reunión? (Expira en 30 min)',
  ].join('\n');
}

/**
 * Revalida si una cita pertenece al contacto y recupera el ID original y Zoom ID desde la base de datos.
 */
async function revalidateContactEvent({ pool, contactNumber, waNumber, eventId }) {
  if (!pool) throw new Error('database_pool_required');
  if (!eventId || !contactNumber) return null;

  try {
    // 1. Buscar en coexistence.ia360_meeting_links
    const { rows: linkRows } = await pool.query(
      `SELECT token, event_id, zoom_meeting_id, zoom_join_url
         FROM coexistence.ia360_meeting_links
        WHERE contact_number = $1 AND event_id = $2
        LIMIT 1`,
      [contactNumber, eventId]
    );
    if (linkRows.length) {
      return {
        eventId: linkRows[0].event_id,
        zoomId: linkRows[0].zoom_meeting_id || linkRows[0].zoom_join_url || null,
      };
    }

    // 2. Buscar en custom_fields->ia360_bookings de coexistence.contacts bajo la misma línea
    const { rows: contactRows } = await pool.query(
      `SELECT c.contact_number, elem->>'event_id' AS evt, elem->>'zoom_id' AS zoom
         FROM coexistence.contacts c,
              LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(c.custom_fields->'ia360_bookings')='array'
                     THEN c.custom_fields->'ia360_bookings' ELSE '[]'::jsonb END
              ) elem
        WHERE c.contact_number = $1 AND ($2 = '' OR c.wa_number = $2) AND elem->>'event_id' = $3
        LIMIT 1`,
      [contactNumber, waNumber || '', eventId]
    );
    if (contactRows.length) {
      return {
        eventId: contactRows[0].evt,
        zoomId: contactRows[0].zoom || null,
      };
    }

    return null;
  } catch (err) {
    console.error('[ia360-agenda] revalidateContactEvent error:', err.message);
    return null;
  }
}

/**
 * Valida el scope del servidor: comprueba que el contacto y línea existan en la DB,
 * y que el source_message_id corresponda a un mensaje entrante real de ese contacto. (FC-SEC-002)
 */
async function verifyServerScope({ pool, contactNumber, waNumber, sourceMessageId }) {
  if (!pool) throw new Error('database_pool_required');
  try {
    // 1. Verificar contacto bajo la línea
    const { rows: contactRows } = await pool.query(
      `SELECT contact_number, wa_number,
              COALESCE(NULLIF(trim(name),''), NULLIF(trim(profile_name),'')) AS contact_name
         FROM coexistence.contacts
        WHERE contact_number = $1 AND wa_number = $2
        LIMIT 1`,
      [contactNumber, waNumber]
    );
    if (!contactRows.length) return null;

    // 2. FC-SEC-002: Verificar que source_message_id existe en chat_history como mensaje entrante de ese contacto y línea
    if (sourceMessageId) {
      const { rows: msgRows } = await pool.query(
        `SELECT id, message_id, contact_number, wa_number, direction, message_body, timestamp
           FROM coexistence.chat_history
          WHERE message_id = $1
            AND contact_number = $2
            AND wa_number = $3
            AND direction = 'incoming'
          LIMIT 1`,
        [sourceMessageId, contactNumber, waNumber]
      );
      if (!msgRows.length) {
        return null;
      }
    }

    return contactRows[0];
  } catch (err) {
    console.error('[ia360-agenda] verifyServerScope error:', err.message);
    return null;
  }
}

/**
 * Crea una propuesta durable y despacha la tarjeta al owner si aplica.
 */
async function proposeAgendaAction({
  pool,
  input,
  sendOwnerInteractive = null,
  loadContactName = null,
  allowPastDates = false,
}) {
  if (!pool) throw new Error('database_pool_required');

  const validation = validateProposalInput(input, { allowPastDates });
  if (!validation.ok) {
    return {
      ok: false,
      state: 'blocked',
      message: `Validación de propuesta fallida: ${validation.errors.join(', ')}`,
    };
  }

  const sanitized = validation.sanitized;

  // Verificación server-side del scope: contacto, línea y source_message_id real en la base de datos (FC-SEC-002)
  const contactScope = await verifyServerScope({
    pool,
    contactNumber: sanitized.contact_number,
    waNumber: sanitized.wa_number,
    sourceMessageId: sanitized.source_message_id,
  });
  if (!contactScope) {
    return {
      ok: false,
      state: 'blocked',
      message: 'El contacto o source_message_id no existe en la base de datos bajo la línea emisora indicada.',
    };
  }

  // Revalidación server-side de la cita y extracción de IDs originales para cancelación
  let resolvedZoomId = null;
  if (sanitized.kind === 'cancel') {
    const eventInfo = await revalidateContactEvent({
      pool,
      contactNumber: sanitized.contact_number,
      waNumber: sanitized.wa_number,
      eventId: sanitized.event_id,
    });
    if (!eventInfo) {
      return {
        ok: false,
        state: 'blocked',
        message: 'El evento a cancelar no pertenece a este contacto en esta línea o no existe.',
      };
    }
    sanitized.event_id = eventInfo.eventId; // ID original preservado
    resolvedZoomId = eventInfo.zoomId;
  }

  // Dry run: cero escrituras a DB, cero envíos al owner, cero efectos
  if (sanitized.dry_run) {
    return {
      ok: true,
      state: 'dry_run',
      message: 'Validación exitosa (dry run, cero efectos).',
    };
  }

  const proposalId = crypto.randomUUID();
  let finalProposalId = proposalId;
  const expiresAt = new Date(Date.now() + PROPOSAL_EXPIRATION_MINUTES * 60 * 1000);
  let resolvedName = sanitized.contact_name || contactScope.contact_name;
  if (!resolvedName && loadContactName) {
    resolvedName = await loadContactName(sanitized.contact_number);
  }
  if (!resolvedName) resolvedName = `contacto ${maskNumber(sanitized.contact_number)}`;

  // Inserción atómica con deduplicación por constraint UNIQUE (source_message_id, kind, payload_hash)
  try {
    const { rows: insertRows } = await pool.query(
      `INSERT INTO coexistence.ia360_agenda_proposals
         (id, wa_number, contact_number, source_message_id, kind, payload_hash, start_utc, end_utc, title, event_id, zoom_id, contact_name, estado, expires_at, detalle_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13, $14::jsonb)
       ON CONFLICT (source_message_id, kind, payload_hash) DO NOTHING
       RETURNING *`,
      [
        proposalId,
        sanitized.wa_number,
        sanitized.contact_number,
        sanitized.source_message_id,
        sanitized.kind,
        sanitized.payload_hash,
        sanitized.start_utc,
        sanitized.end_utc,
        sanitized.title,
        sanitized.event_id,
        resolvedZoomId,
        resolvedName,
        expiresAt.toISOString(),
        JSON.stringify({ source: 'internal_propose', raw_input: input }),
      ]
    );

    if (insertRows.length && insertRows[0].id) {
      finalProposalId = insertRows[0].id;
    } else {
      // Si hubo conflicto de unicidad, se recupera la propuesta existente sin crear duplicados
      const { rows: existingRows } = await pool.query(
        `SELECT id, estado, expires_at FROM coexistence.ia360_agenda_proposals
          WHERE source_message_id = $1 AND kind = $2 AND payload_hash = $3
          LIMIT 1`,
        [sanitized.source_message_id, sanitized.kind, sanitized.payload_hash]
      );
      if (existingRows.length) {
        const existing = existingRows[0];
        const isStillPending = existing.estado === 'pending' && new Date(existing.expires_at).getTime() > Date.now();
        return {
          ok: true,
          proposal_id: existing.id,
          state: isStillPending ? 'pending_owner_confirmation' : existing.estado,
          message: isStillPending
            ? 'Propuesta pendiente existente reutilizada.'
            : `Propuesta previa existente en estado ${existing.estado}.`,
        };
      }
    }
  } catch (dbErr) {
    console.error('[ia360-agenda] error inserting proposal:', dbErr.message);
    return {
      ok: false,
      state: 'blocked',
      message: `Error al persistir la propuesta: ${dbErr.message}`,
    };
  }

  // Despacho de la tarjeta interactiva al owner
  if (sendOwnerInteractive) {
    try {
      const cardBody = formatProposalCardText({
        kind: sanitized.kind,
        startUtc: sanitized.start_utc,
        endUtc: sanitized.end_utc,
        title: sanitized.title,
        contactName: resolvedName,
        contactNumber: sanitized.contact_number,
        eventId: sanitized.event_id,
      });

      const syntheticRecord = {
        wa_number: sanitized.wa_number,
        contact_number: IA360_OWNER_NUMBER,
        message_id: `ia360-agenda-prop-${finalProposalId}`,
        message_body: '',
        message_type: 'text',
      };

      const sent = await sendOwnerInteractive({
        record: syntheticRecord,
        label: `owner_agenda_proposal_${finalProposalId}`,
        messageBody: `IA360: propuesta agenda ${sanitized.kind} ${resolvedName}`,
        targetContact: sanitized.contact_number,
        ownerBudget: true,
        critical: true,
        interactive: {
          type: 'button',
          body: { text: cardBody },
          action: {
            buttons: buildProposalButtons(finalProposalId, sanitized.kind),
          },
        },
      });

      if (!sent) {
        await pool.query(
          `UPDATE coexistence.ia360_agenda_proposals SET delivery_error = 'interactive_send_returned_false' WHERE id = $1`,
          [finalProposalId]
        );
        return {
          ok: false,
          proposal_id: finalProposalId,
          state: 'blocked',
          message: 'No se pudo enviar la tarjeta interactiva al owner (send returned false).',
        };
      }
    } catch (sendErr) {
      console.error('[ia360-agenda] error sending owner card:', sendErr.message);
      await pool.query(
        `UPDATE coexistence.ia360_agenda_proposals SET delivery_error = $2 WHERE id = $1`,
        [finalProposalId, sendErr.message]
      ).catch(() => {});
      return {
        ok: false,
        proposal_id: finalProposalId,
        state: 'blocked',
        message: `Error al despachar la tarjeta interactiva al owner: ${sendErr.message}`,
      };
    }
  }

  return {
    ok: true,
    proposal_id: finalProposalId,
    state: 'pending_owner_confirmation',
    message: 'Propuesta creada, esperando confirmación del owner.',
  };
}

/**
 * Ejecuta el escritor real de reserva contra n8n con verificación estricta.
 */
async function executeBookWriter({
  proposal,
  contactName,
  fetchFn = global.fetch,
  token = process.env.N8N_CALENDAR_TOKEN || '',
  url = N8N_IA360_OWNER_BOOK_WEBHOOK_URL,
}) {
  if (!token || !String(token).trim()) {
    return {
      ok: false,
      verified: false,
      uncertain: false,
      error: 'missing_calendar_token',
      message: 'N8N_CALENDAR_TOKEN no configurado en el backend',
    };
  }

  const payload = {
    inicio_iso: proposal.start_utc,
    fin_iso: proposal.end_utc,
    titulo: proposal.title || 'Reunión IA360',
    nombre_contacto: contactName || proposal.contact_name || 'Contacto',
    numero_contacto: proposal.contact_number,
    confirmado_por_owner: 'true',
    operation_id: proposal.id,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'ForgeChat-Backend/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      if (res.status >= 500) {
        return { ok: false, verified: false, uncertain: true, error: `http_${res.status}`, message: text };
      }
      return { ok: false, verified: false, uncertain: false, error: `http_${res.status}`, message: text };
    }

    let data = {};
    try {
      data = JSON.parse(text || '{}');
    } catch (_) {
      return { ok: false, verified: false, uncertain: true, error: 'invalid_json_response', message: text };
    }

    // Verificación estricta: exige ok===true, verified===true, token y event_id
    if (data.ok === true && data.verified === true && (data.event_id || data.calendar_event_id || data.evento_id) && data.token) {
      const eventId = data.event_id || data.calendar_event_id || data.evento_id;
      return {
        ok: true,
        verified: true,
        state: 'agendada',
        event_id: eventId,
        calendar_event_id: data.calendar_event_id || eventId,
        token: data.token,
        zoom_meeting_id: data.zoom_meeting_id || null,
        zoom_join_url: data.zoom_join_url || null,
        start_utc: data.start_utc || proposal.start_utc,
        end_utc: data.end_utc || proposal.end_utc,
        enlace_estable: data.enlace_estable || `https://wa.geekstudio.dev/api/r/${data.token}`,
      };
    }

    // Si el proveedor respondió 200 pero verified no es true o faltan datos de readback,
    // el evento pudo haberse creado y fallado en el readback -> estado INCIERTO (uncertain: true)
    return {
      ok: false,
      verified: false,
      uncertain: true,
      error: data.error || data.motivo || 'unverified_provider_response',
      message: data.message || data.motivo || 'El proveedor respondió pero la reserva no pudo ser verificada con readback (estado incierto)',
    };
  } catch (err) {
    return {
      ok: false,
      verified: false,
      uncertain: true,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
      message: err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ejecuta el escritor real de cancelación contra n8n con verificación estricta.
 */
async function executeCancelWriter({
  proposal,
  fetchFn = global.fetch,
  token = process.env.N8N_CALENDAR_TOKEN || '',
  url = N8N_IA360_OWNER_CANCEL_WEBHOOK_URL,
}) {
  if (!token || !String(token).trim()) {
    return {
      ok: false,
      verified: false,
      uncertain: false,
      error: 'missing_calendar_token',
      message: 'N8N_CALENDAR_TOKEN no configurado en el backend',
    };
  }

  const payload = {
    evento_id: proposal.event_id,
    event_id: proposal.event_id,
    zoom_id: proposal.zoom_id || '',
    contact_number: proposal.contact_number,
    confirmado_por_owner: 'true',
    operation_id: proposal.id,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'ForgeChat-Backend/1.0',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      if (res.status >= 500) {
        return { ok: false, verified: false, uncertain: true, error: `http_${res.status}`, message: text };
      }
      return { ok: false, verified: false, uncertain: false, error: `http_${res.status}`, message: text };
    }

    let data = {};
    try {
      data = JSON.parse(text || '{}');
    } catch (_) {
      return { ok: false, verified: false, uncertain: true, error: 'invalid_json_response', message: text };
    }

    if (data.ok === true && data.verified === true && (data.event_id || data.evento_id)) {
      return {
        ok: true,
        verified: true,
        state: 'cancelada',
        event_id: data.event_id || data.evento_id || proposal.event_id,
        enlace_retirado: data.enlace_retirado === true,
      };
    }

    // Si el proveedor respondió 200 pero sin verificación completa -> estado INCIERTO (uncertain: true)
    return {
      ok: false,
      verified: false,
      uncertain: true,
      error: data.error || data.motivo || 'unverified_cancel_response',
      message: data.message || data.motivo || 'El proveedor respondió pero la cancelación no pudo ser verificada con readback (estado incierto)',
    };
  } catch (err) {
    return {
      ok: false,
      verified: false,
      uncertain: true,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
      message: err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Procesa la decisión del owner al presionar el botón de confirmación con bloqueo asesor global.
 */
async function handleOwnerAgendaDecision({
  pool,
  record,
  buttonId,
  sendOwnerDirectText,
  sendContactDirectText = null,
  syncDeal = null,
  mergeContactState = null,
  removeBooking = null,
  loadContactName = null,
  fetchFn = global.fetch,
}) {
  if (!record || normalizePhone(record.contact_number) !== IA360_OWNER_NUMBER) {
    console.warn('[ia360-agenda] decision rejected: caller is not owner');
    return false;
  }

  const isYes = buttonId.startsWith('ia360_agenda_yes:');
  const isNo = buttonId.startsWith('ia360_agenda_no:');
  if (!isYes && !isNo) return false;

  const proposalId = buttonId.split(':')[1];
  if (!proposalId) return false;

  if (!pool) throw new Error('database_pool_required');

  const { rows: initialRows } = await pool.query(
    `SELECT * FROM coexistence.ia360_agenda_proposals WHERE id = $1`,
    [proposalId]
  );

  if (!initialRows.length) {
    await sendOwnerDirectText({
      record,
      toNumber: IA360_OWNER_NUMBER,
      label: 'owner_agenda_notfound',
      body: 'No encontré la propuesta de agenda solicitada.',
    });
    return true;
  }

  const proposal = initialRows[0];

  // FC-SEC-005: Verificación estricta de línea: la línea receptora del tap debe coincidir con la de la propuesta
  const recordWa = normalizePhone(record.wa_number);
  if (!recordWa) {
    console.warn('[ia360-agenda] decision rejected: missing record.wa_number');
    return false;
  }

  const proposalWa = normalizePhone(proposal.wa_number);
  if (!proposalWa || proposalWa !== recordWa) {
    console.warn('[ia360-agenda] line mismatch: proposal.wa=%s vs record.wa=%s', proposal.wa_number, record.wa_number);
    await sendOwnerDirectText({
      record,
      toNumber: IA360_OWNER_NUMBER,
      label: 'owner_agenda_line_mismatch',
      body: 'La propuesta pertenece a otra línea de WhatsApp. Operación bloqueada.',
    });
    return true;
  }

  // Si ya no está pending o ya expiró
  const isExpired = new Date(proposal.expires_at).getTime() <= Date.now();
  if (proposal.estado !== 'pending' || isExpired) {
    if (proposal.estado === 'pending' && isExpired) {
      await pool.query(
        `UPDATE coexistence.ia360_agenda_proposals
            SET estado = 'expired', resuelto_at = now()
          WHERE id = $1`,
        [proposalId]
      );
    }
    await sendOwnerDirectText({
      record,
      toNumber: IA360_OWNER_NUMBER,
      label: 'owner_agenda_expired',
      body: `Esta propuesta de agenda ya no está disponible (estado: ${proposal.estado}, expirada o resuelta).`,
    });
    return true;
  }

  // Rechazo explícito
  if (isNo) {
    await pool.query(
      `UPDATE coexistence.ia360_agenda_proposals
          SET estado = 'rejected', owner_decision = 'no', owner_decided_at = now(), resuelto_at = now()
        WHERE id = $1 AND estado = 'pending'`,
      [proposalId]
    );
    await sendOwnerDirectText({
      record,
      toNumber: IA360_OWNER_NUMBER,
      label: 'owner_agenda_rejected',
      body: 'Ok: propuesta de agenda rechazada.',
    });
    return true;
  }

  // Aprobación: Adquisición de cliente dedicado para bloqueo asesor global y reclamo atómico
  let client = null;
  let lockAcquired = false;

  try {
    client = await pool.connect();

    // 1. Intentar adquirir bloqueo asesor global de calendario
    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [CALENDAR_ADVISORY_LOCK_ID]
    );
    lockAcquired = Boolean(lockRows[0]?.locked);

    if (!lockAcquired) {
      // Si el lock está tomado por otra operación: NO consume la confirmación
      await sendOwnerDirectText({
        record,
        toNumber: IA360_OWNER_NUMBER,
        label: 'owner_agenda_busy',
        body: 'El calendario está procesando otra operación en este momento. Por favor reintenta en unos segundos.',
      });
      return true;
    }

    // 2. FC-SEC-005: Transacción de reclamo atómico condicional validando wa_number contra recordWa
    await client.query('BEGIN');
    const { rows: claimRows } = await client.query(
      `UPDATE coexistence.ia360_agenda_proposals
          SET estado = 'executing', owner_decision = 'yes', owner_decided_at = now(), updated_at = now()
        WHERE id = $1 AND estado = 'pending' AND expires_at > now() AND wa_number = $2
        RETURNING *`,
      [proposalId, recordWa]
    );

    if (!claimRows.length) {
      await client.query('ROLLBACK');
      await sendOwnerDirectText({
        record,
        toNumber: IA360_OWNER_NUMBER,
        label: 'owner_agenda_claim_lost',
        body: 'La propuesta ya fue tomada concurrentemente, expiró o la línea no coincide.',
      });
      return true;
    }

    // Commit durable del reclamo antes de ejecutar I/O
    await client.query('COMMIT');
    const activeProposal = claimRows[0];

    let resolvedName = activeProposal.contact_name;
    if (!resolvedName && loadContactName) {
      resolvedName = await loadContactName(activeProposal.contact_number);
    }
    if (!resolvedName) resolvedName = `contacto ${maskNumber(activeProposal.contact_number)}`;

    // 3. Ejecutar escritor
    if (activeProposal.kind === 'book') {
      const writerRes = await executeBookWriter({
        proposal: activeProposal,
        contactName: resolvedName,
        fetchFn,
      });

      if (writerRes.uncertain) {
        await pool.query(
          `UPDATE coexistence.ia360_agenda_proposals
              SET estado = 'execution_uncertain', error_message = $2, updated_at = now()
            WHERE id = $1`,
          [proposalId, writerRes.error || writerRes.message || 'Timeout o fallo de red']
        );
        await sendOwnerDirectText({
          record,
          toNumber: IA360_OWNER_NUMBER,
          label: 'owner_agenda_book_uncertain',
          body: `La reserva de cita entró en estado INCIERTO (${writerRes.error || 'timeout'}). No se reintentará automáticamente para evitar duplicados. Revisa Google Calendar / Zoom.`,
        });
        return true;
      }

      if (!writerRes.ok || !writerRes.verified) {
        await pool.query(
          `UPDATE coexistence.ia360_agenda_proposals
              SET estado = 'failed', error_message = $2, resuelto_at = now()
            WHERE id = $1`,
          [proposalId, writerRes.error || writerRes.message || 'Error en reserva']
        );
        await sendOwnerDirectText({
          record,
          toNumber: IA360_OWNER_NUMBER,
          label: 'owner_agenda_book_failed',
          body: `No se pudo agendar la cita con ${resolvedName} (${writerRes.error || writerRes.message || 'slot ocupado'}).`,
        });
        return true;
      }

      // Éxito verificado
      await pool.query(
        `UPDATE coexistence.ia360_agenda_proposals
            SET estado = 'completed', detalle_json = $2::jsonb, resuelto_at = now()
          WHERE id = $1`,
        [proposalId, JSON.stringify(writerRes)]
      );

      // Actualizar ia360_bookings en el contacto
      if (mergeContactState) {
        try {
          const currentBookings = [];
          const { rows: contactRows } = await pool.query(
            `SELECT custom_fields->'ia360_bookings' AS arr FROM coexistence.contacts WHERE contact_number = $1`,
            [activeProposal.contact_number]
          );
          let existingArr = contactRows[0]?.arr;
          if (typeof existingArr === 'string') {
            try { existingArr = JSON.parse(existingArr); } catch (_) { existingArr = []; }
          }
          if (Array.isArray(existingArr)) currentBookings.push(...existingArr);

          currentBookings.push({
            start: activeProposal.start_utc,
            event_id: writerRes.event_id,
            zoom_id: writerRes.zoom_join_url || writerRes.zoom_meeting_id || '',
          });

          await mergeContactState({
            waNumber: activeProposal.wa_number,
            contactNumber: activeProposal.contact_number,
            customFields: {
              ia360_bookings: currentBookings,
              ia360_booking_event_id: writerRes.event_id,
              ia360_booking_start: activeProposal.start_utc,
            },
          });
        } catch (mergeErr) {
          console.error('[ia360-agenda] error updating contact bookings:', mergeErr.message);
        }
      }

      // Mover deal a 'Reunión agendada'
      if (syncDeal) {
        try {
          await syncDeal({
            record: { ...record, contact_number: activeProposal.contact_number },
            targetStageName: 'Reunión agendada',
            titleSuffix: 'Reunión agendada',
            notes: `Reunión confirmada por Alek. Event ID: ${writerRes.event_id}. Slot: ${activeProposal.start_utc}`,
          });
        } catch (dealErr) {
          console.error('[ia360-agenda] error syncing deal:', dealErr.message);
        }
      }

      const startFmt = formatDateCdMx(activeProposal.start_utc);
      const linkStr = writerRes.enlace_estable ? `\nEnlace: ${writerRes.enlace_estable}` : '';

      if (sendContactDirectText) {
        await sendContactDirectText({
          record,
          toNumber: activeProposal.contact_number,
          label: 'ia360_agenda_book_done_contact',
          body: `Listo, tu reunión quedó agendada para el ${startFmt}.${linkStr}`,
        });
      }

      await sendOwnerDirectText({
        record,
        toNumber: IA360_OWNER_NUMBER,
        label: 'owner_agenda_book_done',
        body: `Hecho: agendé la reunión con ${resolvedName} para el ${startFmt} (Evento: ${writerRes.event_id}).`,
      });
      return true;
    }

    if (activeProposal.kind === 'cancel') {
      const writerRes = await executeCancelWriter({
        proposal: activeProposal,
        fetchFn,
      });

      if (writerRes.uncertain) {
        await pool.query(
          `UPDATE coexistence.ia360_agenda_proposals
              SET estado = 'execution_uncertain', error_message = $2, updated_at = now()
            WHERE id = $1`,
          [proposalId, writerRes.error || 'Timeout de cancelación']
        );
        await sendOwnerDirectText({
          record,
          toNumber: IA360_OWNER_NUMBER,
          label: 'owner_agenda_cancel_uncertain',
          body: `La cancelación de la cita entró en estado INCIERTO. Revisa Google Calendar.`,
        });
        return true;
      }

      if (!writerRes.ok || !writerRes.verified) {
        await pool.query(
          `UPDATE coexistence.ia360_agenda_proposals
              SET estado = 'failed', error_message = $2, resuelto_at = now()
            WHERE id = $1`,
          [proposalId, writerRes.error || 'Error en cancelación']
        );
        await sendOwnerDirectText({
          record,
          toNumber: IA360_OWNER_NUMBER,
          label: 'owner_agenda_cancel_failed',
          body: `No se pudo cancelar la cita con ${resolvedName} (${writerRes.error || 'error'}).`,
        });
        return true;
      }

      // Éxito verificado
      await pool.query(
        `UPDATE coexistence.ia360_agenda_proposals
          SET estado = 'completed', detalle_json = $2::jsonb, resuelto_at = now()
        WHERE id = $1`,
        [proposalId, JSON.stringify(writerRes)]
      );

      if (removeBooking) {
        try {
          await removeBooking({
            waNumber: activeProposal.wa_number,
            contactNumber: activeProposal.contact_number,
            eventId: activeProposal.event_id,
          });
        } catch (remErr) {
          console.error('[ia360-agenda] error removing booking from contact:', remErr.message);
        }
      }

      if (sendContactDirectText) {
        await sendContactDirectText({
          record,
          toNumber: activeProposal.contact_number,
          label: 'ia360_agenda_cancel_done_contact',
          body: 'Tu reunión ha sido cancelada conforme a lo solicitado.',
        });
      }

      await sendOwnerDirectText({
        record,
        toNumber: IA360_OWNER_NUMBER,
        label: 'owner_agenda_cancel_done',
        body: `Hecho: cancelé la cita con ${resolvedName} (Evento: ${activeProposal.event_id}).`,
      });
      return true;
    }
  } finally {
    if (lockAcquired && client) {
      await client.query(`SELECT pg_advisory_unlock($1)`, [CALENDAR_ADVISORY_LOCK_ID]).catch(err => {
        console.error('[ia360-agenda] error unlocking advisory lock:', err.message);
      });
    }
    if (client) {
      client.release();
    }
  }

  return false;
}

/**
 * Procesa comentarios del owner en tarjetas de fallo (ia360_awaiting_comment_failure)
 * pasando la instrucción al agente IA360 en modo 'owner_assistance' con contexto estructurado.
 *
 * CONTRATO DE AUDIENCIA Y RESOLUCIÓN:
 * 1. Solo envía al contacto si agentRes.response_audience === 'contact' Y agentRes.action === 'reply_to_contact'.
 * 2. Si la respuesta es para el owner (o una consulta interna), se despacha a Alek.
 * 3. NO limpia el flag ia360_awaiting_comment_failure prematuramente; solo se limpia tras despacho exitoso al contacto.
 * 4. Correlaciona el source_message_id real desde chat_history comparando fecha (<= timestamp del owner) y contenido con el snapshot.
 */
async function handleOwnerFailureAssistance({
  pool,
  record,
  failureId,
  comment,
  loadFailureTarget,
  callIa360Agent,
  enqueueIa360Text,
  sendIa360DirectText,
  mergeContactState,
}) {
  if (!pool) throw new Error('database_pool_required');

  const target = await loadFailureTarget(failureId);
  const targetNumber = normalizePhone(target?.contact_number || '');
  if (!target || !targetNumber) {
    return { ok: false, reason: 'missing_target' };
  }

  if (!record || !record.timestamp) {
    if (sendIa360DirectText) {
      await sendIa360DirectText({
        record,
        toNumber: IA360_OWNER_NUMBER,
        label: 'owner_comment_fail_missing_time',
        body: 'El mensaje del owner no incluye timestamp válido para correlacionar con el historial.',
      });
    }
    return { ok: false, reason: 'missing_owner_timestamp' };
  }

  const ownerTimestamp = new Date(record.timestamp);
  if (isNaN(ownerTimestamp.getTime())) {
    return { ok: false, reason: 'invalid_owner_timestamp' };
  }

  await pool.query(
    `UPDATE coexistence.ia360_bot_failures
        SET owner_comment = $1, owner_action = 'respondio_con_comentario', status = 'comentario_recibido'
      WHERE id = $2`,
    [comment, failureId]
  ).catch(e => console.error('[ia360-failure] save comment:', e.message));

  // Resolver source_message_id real desde chat_history correlacionando contenido y timestamp <= comentario del owner
  let resolvedSourceMessageId = null;
  const failureSnapshotBody = String(target.contact_message || '').trim();

  try {
    const { rows: histRows } = await pool.query(
      `SELECT message_id, message_body, timestamp
         FROM coexistence.chat_history
        WHERE contact_number = $1
          AND wa_number = $2
          AND direction = 'incoming'
          AND timestamp <= $3
        ORDER BY timestamp DESC
        LIMIT 10`,
      [targetNumber, target.contact_wa_number || record.wa_number, ownerTimestamp]
    );

    for (const row of histRows) {
      const rowBody = String(row.message_body || '').trim();
      if (rowBody && failureSnapshotBody && (failureSnapshotBody.includes(rowBody) || rowBody.includes(failureSnapshotBody))) {
        resolvedSourceMessageId = row.message_id;
        break;
      }
    }
  } catch (histErr) {
    console.error('[ia360-failure] error resolving source_message_id:', histErr.message);
  }

  // Si no se correlaciona con certeza el mensaje original del fallo, preservar pendiente y pedir clarificación al owner
  if (!resolvedSourceMessageId) {
    if (sendIa360DirectText) {
      await sendIa360DirectText({
        record,
        toNumber: IA360_OWNER_NUMBER,
        label: 'owner_comment_fail_unresolved',
        body: `No pude correlacionar con certeza el mensaje original del fallo (#${failureId}) con el historial del contacto. Por seguridad, el caso permanece abierto en el CRM para tu revisión manual.`,
      });
    }
    return { ok: false, reason: 'unresolved_source_message', contactNumber: targetNumber };
  }

  const targetRecord = {
    ...record,
    contact_number: targetNumber,
    wa_number: target.contact_wa_number || record.wa_number,
    contact_name: target.contact_name || '',
    message_id: resolvedSourceMessageId,
    message_type: 'text',
    message_body: target.contact_message || '',
  };

  // Invocar al agente IA360 en modo owner_assistance con campos estructurados
  let agentRes = null;
  try {
    agentRes = await callIa360Agent({
      record: targetRecord,
      stageName: 'Supervisado Owner',
      roleHint: 'owner_assistance',
      threadContext: {
        input_mode: 'owner_assistance',
        owner_instruction: comment,
        original_request: target.contact_message,
        failure_id: failureId,
        failure_reason: target.reason,
        source_message_id: resolvedSourceMessageId,
        owner_message_id: record.message_id || null,
      },
    });
  } catch (agentErr) {
    console.error('[ia360-failure] callIa360Agent error:', agentErr.message);
  }

  const contactName = target.contact_name || `contacto ${maskNumber(targetNumber)}`;

  // Evaluación estricta de audiencia: solo responder al contacto si response_audience === 'contact' Y action === 'reply_to_contact'
  if (agentRes && agentRes.reply && String(agentRes.reply).trim()) {
    const replyBody = String(agentRes.reply).trim();
    const isContactAudience = agentRes.response_audience === 'contact' && agentRes.action === 'reply_to_contact';

    if (isContactAudience) {
      let sent = false;
      if (enqueueIa360Text) {
        sent = await enqueueIa360Text({
          record: targetRecord,
          label: 'ia360_owner_assisted_reply',
          body: replyBody,
        });
      }

      await pool.query(
        `UPDATE coexistence.ia360_bot_failures
            SET status = $1
          WHERE id = $2`,
        [sent === true ? 'respondido_por_agente' : 'comentado_envio_fallo', failureId]
      ).catch(e => console.error('[ia360-failure] mark status:', e.message));

      // Solo limpiar el awaiting flag cuando la respuesta al contacto se ha enviado exitosamente
      if (mergeContactState && sent === true) {
        await mergeContactState({
          waNumber: record.wa_number,
          contactNumber: record.contact_number,
          customFields: { ia360_awaiting_comment_failure: '' },
        }).catch(e => console.error('[ia360-failure] clear awaiting:', e.message));
      }

      if (sendIa360DirectText) {
        await sendIa360DirectText({
          record,
          toNumber: IA360_OWNER_NUMBER,
          label: 'owner_comment_fail_saved',
          body: sent === true
            ? `Listo: procesé tu indicación con IA360 y le respondí a ${contactName}.`
            : `Guardé tu comentario, pero falló el envío al contacto (${contactName}).`,
        });
      }

      return { ok: sent === true, handled: 'agent_reply_to_contact', contactName, contactNumber: targetNumber };
    }

    // Si la audiencia es owner: enviar la respuesta de IA360 a Alek sin limpiar el awaiting flag
    if (sendIa360DirectText) {
      await sendIa360DirectText({
        record,
        toNumber: IA360_OWNER_NUMBER,
        label: 'owner_comment_assistant_info',
        body: replyBody,
      });
    }

    return { ok: true, handled: 'owner_info', contactName, contactNumber: targetNumber };
  }

  // Si el agente falló o no dio respuesta utilizable: NUNCA hacer relay literal
  await pool.query(
    `UPDATE coexistence.ia360_bot_failures
        SET status = 'comentado_agente_fallo'
      WHERE id = $1`,
    [failureId]
  ).catch(e => console.error('[ia360-failure] mark status fail:', e.message));

  if (sendIa360DirectText) {
    await sendIa360DirectText({
      record,
      toNumber: IA360_OWNER_NUMBER,
      label: 'owner_comment_fail_saved',
      body: `Guardé tu comentario, pero IA360 no generó una respuesta utilizable. El caso permanece abierto en el CRM.`,
    });
  }

  return { ok: true, handled: 'pending_crm', contactName, contactNumber: targetNumber };
}

module.exports = {
  PROPOSAL_EXPIRATION_MINUTES,
  PROPOSAL_STATES,
  IA360_OWNER_NUMBER,
  CALENDAR_ADVISORY_LOCK_ID,
  N8N_IA360_OWNER_BOOK_WEBHOOK_URL,
  N8N_IA360_OWNER_CANCEL_WEBHOOK_URL,
  normalizePhone,
  maskNumber,
  formatDateCdMx,
  formatTimeCdMx,
  computePayloadHash,
  validateProposalInput,
  buildProposalButtons,
  formatProposalCardText,
  revalidateContactEvent,
  verifyServerScope,
  proposeAgendaAction,
  executeBookWriter,
  executeCancelWriter,
  handleOwnerAgendaDecision,
  handleOwnerFailureAssistance,
};
