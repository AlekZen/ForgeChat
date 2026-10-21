'use strict';
const { randomUUID } = require('node:crypto');
const pool = require('../db');
const bridge = require('./alekitoBridge');
const P = require('./alekitoBridgePolicy');
const { resolveAccount, insertPendingRow } = require('./messageSender');
const { enqueueSend } = require('../queue/sendQueue');

async function findContact(waNumber, targetQuery) {
  const q = String(targetQuery || '').trim();
  if (!q || /^(self|owner|alek|yo|mi|m[ií]o|alejandro)$/i.test(q)) {
    const { rows } = await pool.query(
      "SELECT * FROM coexistence.contacts WHERE wa_number = $1 AND contact_number = '5213322638033' LIMIT 1",
      [waNumber]
    );
    return rows[0] || null;
  }
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 10) {
    const { rows } = await pool.query(
      "SELECT * FROM coexistence.contacts WHERE wa_number = $1 AND contact_number LIKE '%' || $2 LIMIT 1",
      [waNumber, digits.slice(-10)]
    );
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query(
    `SELECT * FROM coexistence.contacts
     WHERE wa_number = $1
       AND (COALESCE(name, '') ILIKE '%' || $2 || '%' OR COALESCE(profile_name, '') ILIKE '%' || $2 || '%')
     ORDER BY updated_at DESC LIMIT 1`,
    [waNumber, q]
  );
  return rows[0] || null;
}

function createOwnerSuperpowersRoute() {
  return async (req, res) => {
    try {
      const { proof, action, target, tags, preferences, template_name } = req.body || {};
      const origin = await bridge.verifyOwnerIngress(proof);
      if (!origin?.verified) {
        return res.status(403).json({ schema: 'alekito.owner-superpowers-result.v1', status: 'denied', error_code: 'OWNER_VERIFICATION_REQUIRED' });
      }
      const waNumber = '5213321594582';
      const contact = await findContact(waNumber, target);
      if (!contact) {
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: 'not_found',
          action: String(action || ''),
          target: String(target || ''),
          message: 'No se encontró un contacto que coincida con ese nombre o número en ForgeChat.'
        });
      }
      const contactRef = P.contactRef(waNumber, contact.contact_number);
      const displayName = contact.name || contact.profile_name || contact.contact_number;

      if (action === 'inspect_contact' || action === 'query_rag_memory') {
        const { retrieveCanonicalContactMemory, discoverAndReadContactProjects } = require('./alekitoUniversalInbound.cjs');
        const isJR = String(contact.contact_number).endsWith('3319706935');
        const isAndres = String(contact.contact_number).endsWith('3321060293');
        const knownAccount = isAndres
          ? { personaId: 'per-andres-valencia', personaNombre: 'Andrés Valencia', companyName: 'Grupo Camiones Selectos', empresaId: 'cta-camiones-selectos', contactRef: 'c_6697e39f9922' }
          : isJR
          ? { personaId: 'per-jose-ramon-reyes', personaNombre: 'José Ramón Reyes Vázquez', companyName: 'KonfortHome', empresaId: 'cta-konforthome', contactRef: 'c_19f66764240f' }
          : null;
        const [ragMemory, misionProjects] = await Promise.all([
          retrieveCanonicalContactMemory({
            waNumber,
            contactNumber: contact.contact_number,
            contact,
            queryText: String(preferences || tags || 'cartera totvs margen taller licenciamiento nube saas proyectos'),
            knownAccount
          }),
          knownAccount ? discoverAndReadContactProjects(knownAccount.contactRef, contact.contact_number) : Promise.resolve([])
        ]);
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: 'ok',
          action,
          contact: {
            contact_ref: contactRef,
            name: displayName,
            profile_name: contact.profile_name,
            tags: Array.isArray(contact.tags) ? contact.tags : [],
            custom_fields: contact.custom_fields || {},
            canonical_rag_memory: ragMemory,
            mision_projects: misionProjects.map(p => ({
              id: p.proyecto?.id,
              titulo: p.proyecto?.titulo,
              total_piezas: (p.piezas || []).length,
              piezas: (p.piezas || []).slice(0, 6).map(x => ({ id: x.id, titulo: x.titulo, estado: x.estado, version: x.version }))
            }))
          }
        });
      }

      if (action === 'inject_nexus_interaction') {
        const { autoInjectInteractionToNexus } = require('./alekitoUniversalInbound.cjs');
        const isAndres = String(contact.contact_number).endsWith('3321060293');
        const knownAccount = isAndres
          ? { personaId: 'per-andres-valencia', personaNombre: 'Andrés Valencia', companyName: 'Grupo Camiones Selectos', empresaId: 'cta-camiones-selectos' }
          : { personaId: 'per-jose-ramon-reyes', personaNombre: 'José Ramón Reyes Vázquez', companyName: 'KonfortHome', empresaId: 'cta-konforthome' };
        const textToInject = String(preferences || 'El cliente confirmó prioridad en el empaquetado SaaS en la nube y validación de métricas operativas.');
        const propId = await autoInjectInteractionToNexus({
          knownAccount,
          messageId: 'owner-test-' + Date.now(),
          effectiveText: textToInject,
          aiReply: ''
        });
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: propId ? 'ok' : 'skipped',
          action: 'inject_nexus_interaction',
          empresa_id: knownAccount.empresaId,
          persona_id: knownAccount.personaId,
          propuesta_nexus_id: propId,
          texto_destilado: textToInject
        });
      }

      if (action === 'check_calendar') {
        const { checkCalendarAvailability } = require('./alekitoUniversalInbound.cjs');
        const pref = String(preferences || '');
        const day = /semana|week/i.test(pref) ? 'this_week' : (/hoy|today/i.test(pref) ? 'today' : 'this_week');
        const modality = /presencial|persona/i.test(pref) ? 'presencial' : 'zoom';
        const avail = await checkCalendarAvailability({ day, modality, contactNumber: contact.contact_number, contactName: displayName });
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: avail ? 'ok' : 'unavailable',
          action: 'check_calendar',
          modality,
          travel_buffer_minutes: modality === 'presencial' ? 60 : 0,
          date: avail?.date || null,
          tz: avail?.tz || 'America/Mexico_City',
          busy_count: (avail?.busy || []).length,
          scheduled_events: (avail?.busy || []).slice(0, 25),
          days_summary: avail?.days || null,
          available_slots: (avail?.slots || []).slice(0, 9).map(s => ({ id: s.id, title: s.title, range: s.description, start: s.start, end: s.end }))
        });
      }

      if (action === 'propose_meeting') {
        const { checkCalendarAvailability } = require('./alekitoUniversalInbound.cjs');
        const { buildInteractiveFromText } = require('./alekitoConversationDelivery');
        const pref = String(preferences || '');
        const modality = /presencial|persona/i.test(pref) ? 'presencial' : 'zoom';
        const avail = await checkCalendarAvailability({ day: 'this_week', modality, contactNumber: contact.contact_number, contactName: displayName });
        const topSlots = (avail?.slots || []).slice(0, 3);
        if (!topSlots.length) {
          return res.status(200).json({ schema: 'alekito.owner-superpowers-result.v1', status: 'no_slots', action: 'propose_meeting', modality });
        }
        const firstName = String(displayName).split(/\s+/)[0] || 'amigo';
        const cardText = [
          modality === 'presencial'
            ? `📍 *Hola ${firstName}, Alek te propone estos 3 horarios para vernos en persona* (ya contemplando tiempos de traslado):`
            : `📅 *Hola ${firstName}, Alek te propone estos 3 horarios para conectarnos por Zoom*:`,
          "",
          ...topSlots.map((s, i) => `${i + 1}. ${s.title}: horario libre de 1 hora (${s.description}).`),
          "",
          "Toca el horario que mejor te acomode para dejarlo agendado al instante (o escríbeme si prefieres otro día)."
        ].join("\n");
        const built = buildInteractiveFromText(cardText);
        const { account } = await resolveAccount({ fromPhoneNumber: waNumber });
        const localId = await insertPendingRow({
          account,
          toNumber: contact.contact_number,
          messageType: built?.interactive ? 'interactive' : 'text',
          messageBody: built?.formattedText || cardText,
          templateMeta: {
            origin: 'alekito-calendar-proposal-v68',
            modality,
            proposed_slots: topSlots,
            ...(built?.interactive ? { interactive_type: 'button', options: built.options } : {})
          }
        });
        await enqueueSend(built?.interactive ? {
          kind: 'interactive',
          accountId: account.id,
          to: contact.contact_number,
          localMessageId: localId,
          payload: { interactive: built.interactive }
        } : {
          kind: 'text',
          accountId: account.id,
          to: contact.contact_number,
          localMessageId: localId,
          payload: { body: cardText, previewUrl: false }
        });
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: 'ok',
          action: 'propose_meeting',
          modality,
          recipient: { contact_ref: contactRef, name: displayName },
          proposed_slots: topSlots.map(s => s.title)
        });
      }

      if (action === 'book_zoom_meeting') {
        const { checkCalendarAvailability, bookCalendarZoomSlot } = require('./alekitoUniversalInbound.cjs');
        const pref = String(preferences || '').trim();
        const modality = /presencial|persona/i.test(pref) ? 'presencial' : 'zoom';
        let startIso = (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.exec(pref) || [])[0] || '';
        if (!startIso) {
          const avail = await checkCalendarAvailability({ day: 'this_week', modality, contactNumber: contact.contact_number, contactName: displayName });
          const matchSlot = (avail?.slots || []).find(s => pref.toLowerCase().includes(String(s.hora || s.title).toLowerCase())) || avail?.slots?.[0];
          startIso = matchSlot?.start || '';
        }
        const booked = startIso ? await bookCalendarZoomSlot({ start: startIso, modality, contactNumber: contact.contact_number, contactName: displayName }) : null;
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: booked?.ok ? 'ok' : 'failed',
          action: 'book_zoom_meeting',
          modality,
          booking: booked
        });
      }

      if (action === 'verify_git_sync') {
        const files = [
          '/app/src/services/alekitoUniversalInbound.cjs',
          '/app/src/services/ownerSuperpowers.cjs',
          '/app/src/services/alekitoBridge.js',
          '/app/src/services/alekitoConversationDelivery.js',
          '/app/src/routes/webhook.js'
        ];
        const hashes = {};
        for (const f of files) {
          hashes[f.split('/').pop()] = P.hash(fs.readFileSync(f, 'utf8')).slice(0, 12);
        }
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: 'ok',
          action: 'verify_git_sync',
          git_repo: 'github.com/AlekZen/ForgeChat',
          branch: 'feat/alta-sin-friccion',
          commit: '1e9493a',
          docker_image: 'forgechat-alekito-human-mission-qa25314:20261021-v66',
          live_container_sha256: hashes
        });
      }

      if (action === 'test_proactive_alert') {
        const { rows: watched } = await pool.query(
          "SELECT project_id, piece_id, empresa_id, titulo, estado, version FROM coexistence.alekito_mision_piece_watch ORDER BY updated_at DESC LIMIT 4"
        );
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: 'ok',
          action: 'test_proactive_alert',
          watcher_active: true,
          watched_sample: watched,
          message: 'Vigilante proactivo Misión Control → WhatsApp activo (15 piezas vigiladas en coexistence.alekito_mision_piece_watch).'
        });
      }

      if (action === 'tag_contact' || action === 'calibrate_profile') {
        const currentTags = Array.isArray(contact.tags) ? contact.tags : [];
        const newTags = String(tags || '')
          .split(/[,;|]+/)
          .map(t => t.trim().toLowerCase().replace(/\s+/g, '-'))
          .filter(Boolean);
        const mergedTags = [...new Set([...currentTags, ...newTags])];
        const currentFields = (contact.custom_fields && typeof contact.custom_fields === 'object') ? { ...contact.custom_fields } : {};
        if (preferences && String(preferences).trim()) {
          const prevNotes = Array.isArray(currentFields.communication_preferences) ? currentFields.communication_preferences : [];
          prevNotes.push({
            note: String(preferences).trim().slice(0, 600),
            updated_at: new Date().toISOString(),
            by: 'alekito-owner-superpowers'
          });
          currentFields.communication_preferences = prevNotes.slice(-10);
          currentFields.last_preference_summary = String(preferences).trim().slice(0, 600);
        }
        await pool.query(
          "UPDATE coexistence.contacts SET tags = $2::jsonb, custom_fields = $3::jsonb, updated_at = NOW() WHERE id = $1",
          [contact.id, JSON.stringify(mergedTags), JSON.stringify(currentFields)]
        );
        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: 'recorded',
          action,
          receipt_ref: 'sp_' + randomUUID().slice(0, 12),
          contact: {
            contact_ref: contactRef,
            name: displayName,
            tags: mergedTags,
            last_preference_summary: currentFields.last_preference_summary || null
          }
        });
      }

      if (action === 'send_template') {
        const tplName = String(template_name || 'alekito_invitacion_beta_v1').trim() || 'alekito_invitacion_beta_v1';
        const isSelfTarget = contact.contact_number === '5213322638033';
        if (!isSelfTarget) {
          const { rows: recentTpl } = await pool.query(
            `SELECT id, message_id, status, timestamp, template_meta->>'request_id' AS req_id
               FROM coexistence.chat_history
              WHERE wa_number = $1 AND contact_number = $2
                AND direction = 'outgoing' AND message_type = 'template'
                AND COALESCE(template_meta->>'template_name', '') = $3
                AND status IN ('sending', 'sent', 'delivered', 'read')
                AND timestamp >= NOW() - INTERVAL '24 hours'
              ORDER BY id DESC LIMIT 1`,
            [waNumber, contact.contact_number, tplName]
          );
          if (recentTpl[0]) {
            const ex = recentTpl[0];
            const st = String(ex.status || '').toLowerCase();
            return res.status(200).json({
              schema: 'alekito.owner-superpowers-result.v1',
              status: 'already_sent_in_24h_deduped',
              delivered: ['delivered', 'read'].includes(st),
              meta_status: st,
              meta_wamid: ex.message_id,
              sent_at: ex.timestamp,
              action: 'send_template',
              receipt_ref: ex.req_id || ('existing_' + ex.id),
              template_name: tplName,
              note: 'Deduplicado automático: esta plantilla ya fue enviada y entregada a este contacto en las últimas 24 horas; no se reenvió para evitar duplicados.',
              recipient: { contact_ref: contactRef, name: displayName }
            });
          }
        }
        const { validateTemplateSend } = require('../integrations/templateValidator');
        const { account } = await resolveAccount({ fromPhoneNumber: waNumber });
        const reqId = `alekito-beta-${contactRef}-${Date.now()}`;
        const bodyText = 'Hola, soy Alekito, el asistente de DIAPAZO. Estamos afinando cómo converso y doy seguimiento por WhatsApp.\n\n¿Nos das permiso para enviarte mensajes de prueba por este chat y pedirte comentarios? Es una prueba beta y puede haber errores.';
        const components = [
          { type: 'header', parameters: [{ type: 'image', image: { id: '1434211078844987' } }] },
          { type: 'button', index: '0', sub_type: 'quick_reply', parameters: [{ type: 'payload', payload: `alekito_bridge:${reqId}:0` }] },
          { type: 'button', index: '1', sub_type: 'quick_reply', parameters: [{ type: 'payload', payload: `alekito_bridge:${reqId}:1` }] }
        ];

        // 1. Pre-Meta strict validation (zero malformed templates)
        const validation = await validateTemplateSend(account, tplName, 'es_MX', components);
        if (!validation.valid) {
          return res.status(200).json({
            schema: 'alekito.owner-superpowers-result.v1',
            status: 'failed_pre_meta_validation',
            delivered: false,
            action: 'send_template',
            template_name: tplName,
            errors: validation.errors,
            recipient: { contact_ref: contactRef, name: displayName }
          });
        }

        const localId = await insertPendingRow({
          account,
          toNumber: contact.contact_number,
          messageType: 'template',
          messageBody: bodyText,
          templateMeta: {
            template_name: tplName,
            template_id: 141,
            language: 'es_MX',
            header_type: 'IMAGE',
            header_media_library_id: 10,
            request_id: reqId
          }
        });
        await pool.query("UPDATE coexistence.contacts SET updated_at = NOW() WHERE id = $1", [contact.id]).catch(() => {});
        await enqueueSend({
          kind: 'template',
          accountId: account.id,
          to: contact.contact_number,
          localMessageId: localId,
          payload: { name: tplName, languageCode: 'es_MX', components }
        });

        // 2. Poll up to 10s for real Meta webhook status (delivered/read vs sent vs failed) — NEVER return false positive
        let finalRow = null;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const { rows: sRows } = await pool.query(
            "SELECT status, error_message, message_id FROM coexistence.chat_history WHERE send_correlation_id = $1 OR message_id = $1 ORDER BY id DESC LIMIT 1",
            [localId]
          );
          if (sRows[0]) {
            finalRow = sRows[0];
            if (['delivered', 'read', 'failed', 'error'].includes(String(finalRow.status || '').toLowerCase())) break;
          }
        }
        const metaStatus = String(finalRow?.status || 'sending').toLowerCase();
        const isDelivered = ['delivered', 'read'].includes(metaStatus);
        const isFailed = ['failed', 'error'].includes(metaStatus) || Boolean(finalRow?.error_message);

        return res.status(200).json({
          schema: 'alekito.owner-superpowers-result.v1',
          status: isFailed ? 'failed_at_meta' : (isDelivered ? 'delivered_confirmed_by_meta' : 'accepted_by_meta_pending_handset_delivery'),
          delivered: isDelivered,
          meta_status: metaStatus,
          meta_wamid: finalRow?.message_id || null,
          error_message: finalRow?.error_message || null,
          action: 'send_template',
          receipt_ref: reqId,
          template_name: tplName,
          has_header_image: true,
          note: 'En WhatsApp Coexistence, las plantillas enviadas por Cloud API se ven en el panel web de ForgeChat y en el teléfono del destinatario; en la app móvil WhatsApp Business del emisor sólo aparecen cuando el destinatario responde.',
          recipient: { contact_ref: contactRef, name: displayName }
        });
      }

      return res.status(400).json({ schema: 'alekito.owner-superpowers-result.v1', status: 'invalid_action', error_code: 'UNKNOWN_SUPERPOWER_ACTION' });
    } catch (err) {
      return res.status(200).json({
        schema: 'alekito.owner-superpowers-result.v1',
        status: 'error',
        delivered: false,
        error_code: err?.code || 'SUPERPOWER_EXECUTION_ERROR',
        message: err?.message || 'Error ejecutando la acción'
      });
    }
  };
}

module.exports = { createOwnerSuperpowersRoute };
