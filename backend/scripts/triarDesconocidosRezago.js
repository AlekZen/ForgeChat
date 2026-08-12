// Los desconocidos que ya escribieron y nunca recibieron respuesta.
//
// El carril de triaje (webhook.js → handleIa360Desconocido) atiende lo que llega de
// hoy en adelante. Esto es para el REZAGO: la gente que escribió antes de que el
// carril existiera y se quedó esperando. Medido el 12-ago-2026: 4 personas en 90
// días, una de ellas con tres mensajes el mismo día.
//
// Reglas duras:
//   · Sólo contactos SIN deal, SIN marca de cliente activo/beta y SIN triaje previo.
//   · Sólo dentro de la ventana de 24 h de WhatsApp: fuera de ella un texto libre lo
//     rechaza Meta (131047), así que se listan pero no se les escribe.
//   · Nunca el owner, nunca números QA.
//   · Pasa por el MISMO handler que producción: mismo copy, mismo ledger, misma
//     tarjeta al owner. Nada de una segunda implementación que se desincroniza.
//
//   docker exec forgecrm-backend node /app/scripts/triarDesconocidosRezago.js
//   docker exec forgecrm-backend node /app/scripts/triarDesconocidosRezago.js --apply
//   docker exec forgecrm-backend node /app/scripts/triarDesconocidosRezago.js --apply --contacto 5213317399146

const pool = require('/app/src/db');
const { handleIa360Desconocido } = require('/app/src/routes/webhook');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const valorDe = (bandera, porDefecto) => {
  const i = args.indexOf(bandera);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};
const CONTACTO = valorDe('--contacto', '');
const OWNER = '5213322638033';

(async () => {
  // Último entrante de cada desconocido, con las horas que lleva esperando.
  const { rows } = await pool.query(
    `WITH ultimos AS (
       SELECT DISTINCT ON (h.contact_number)
              h.message_id, h.wa_number, h.contact_number,
              h.message_type, h.message_body, h.direction, h.created_at
         FROM coexistence.chat_history h
        WHERE h.direction = 'incoming'
          AND h.contact_number <> $1
          AND h.contact_number !~ '^52199900[0-9]{5}$'
          AND ($2 = '' OR h.contact_number = $2)
        ORDER BY h.contact_number, h.id DESC
     )
     SELECT u.*,
            EXTRACT(EPOCH FROM (NOW() - u.created_at)) / 3600 AS horas,
            c.id AS contact_id, COALESCE(c.name, c.profile_name) AS nombre,
            c.custom_fields
       FROM ultimos u
       LEFT JOIN coexistence.contacts c
              ON c.wa_number = u.wa_number AND c.contact_number = u.contact_number
      WHERE NOT EXISTS (SELECT 1 FROM coexistence.chat_history o
                         WHERE o.direction = 'outgoing'
                           AND o.contact_number = u.contact_number
                           AND o.created_at > u.created_at)
        AND NOT EXISTS (SELECT 1 FROM coexistence.deals d
                         WHERE d.contact_number = u.contact_number)
        AND COALESCE(c.custom_fields->'ia360_triaje'->>'estado', '') = ''
        AND COALESCE(c.custom_fields->>'lifecycle_stage', '') NOT LIKE 'cliente_activo%'
        AND c.custom_fields->'ia360_cliente_activo_beta' IS NULL
      ORDER BY u.created_at DESC`,
    [OWNER, CONTACTO]
  );

  if (!rows.length) { console.log('  No hay desconocidos esperando respuesta.'); process.exit(0); }
  console.log(`  ${rows.length} desconocido(s) sin respuesta${APPLY ? '' : ' (dry-run: no manda nada)'}\n`);

  let atendidos = 0, fuera = 0;
  for (const r of rows) {
    const horas = Number(r.horas);
    const quien = r.nombre || r.contact_number;
    const resumen = String(r.message_body || '').replace(/\s+/g, ' ').slice(0, 90);
    if (horas >= 24) {
      fuera++;
      console.log(`  [FUERA DE VENTANA ${horas.toFixed(0)} h] ${quien}: "${resumen}"`);
      continue;
    }
    console.log(`  [EN VENTANA ${horas.toFixed(1)} h] ${quien}: "${resumen}"`);
    if (!APPLY) continue;
    const contacto = r.contact_id
      ? { id: r.contact_id, name: r.nombre, custom_fields: r.custom_fields || {} }
      : null;
    const respondido = await handleIa360Desconocido({
      record: {
        message_id: r.message_id,
        wa_number: r.wa_number,
        contact_number: r.contact_number,
        contact_name: r.nombre || null,
        message_type: r.message_type,
        message_body: r.message_body,
        direction: 'incoming',
      },
      contact: contacto,
    }).catch(e => { console.error('    error:', e.message); return false; });
    if (respondido) atendidos++;
    console.log(`    → ${respondido ? 'sondeado' : 'sin respuesta (ver log del backend)'}`);
  }

  console.log(`\n  atendidos: ${atendidos}   fuera de la ventana de 24 h: ${fuera}`);
  if (!APPLY) console.log('  Nada se envió. Corre con --apply.');
  // Las respuestas se encolan en BullMQ; un exit inmediato puede cortar el worker.
  setTimeout(() => process.exit(0), APPLY ? 4000 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
