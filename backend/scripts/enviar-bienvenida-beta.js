// Bienvenida formal al beta de IA360 — envío único, aprobado por Alek (12-ago-2026).
//
// POR QUÉ ES UN SCRIPT Y NO UN CARRIL: es un mensaje de owner a UN contacto real
// (Elliot, 5213313663740), con imagen, redactado y aprobado a mano. No hay trigger
// que lo dispare ni debe repetirse: se corre una vez, deja rastro en chat_history
// y registra en ia360_bot_failures la promesa que el texto hace, para que el digest
// la envejezca y alguien la cierre (regla: toda promesa entra al ledger o no se hace).
//
// GUARDA DE VENTANA: WhatsApp sólo permite mensaje libre dentro de las 24 h del
// último entrante del contacto. Si la ventana cerró, ABORTA — no se improvisa un
// template (eso exige aprobación de Meta y es otra ronda).
//
//   docker exec forgecrm-backend node /app/scripts/enviar-bienvenida-beta.js
//   docker exec forgecrm-backend node /app/scripts/enviar-bienvenida-beta.js --apply

const fs = require('fs');
const pool = require('/app/src/db');
const { uploadMedia } = require('/app/src/integrations/metaSend');
const { resolveAccount, insertPendingRow } = require('/app/src/services/messageSender');
const { enqueueSend } = require('/app/src/queue/sendQueue');

const APPLY = process.argv.slice(2).includes('--apply');

const DESTINO = '5213313663740';
const WA_NUMBER = '5213321594582';
const IMAGEN = '/app/assets/bienvenida-elliot.png';

const CAPTION = `Elliot, bienvenido formalmente al beta de IA360 — y gracias.

Te recibo como uno de los grandes aliados de mi capítulo de BNI Industrial Jalisco. Estar en el beta significa tres cosas concretas: lo que pidas entra a la lista real de prioridades, ves las cosas antes que nadie, y no te cuesta más que tu franqueza.

Cómo aprovecharlo: escríbele a este WhatsApp como si fuera tu asistente. Te contesta Alekito, ya conoce tu contexto y me pasa lo que necesites. Pregunta, pide, reclama.

Ya me dijiste dónde duele: el registro entra al CRM pero nadie lo pasa al listado, y el Excel de seguimiento nadie lo llena. Con eso te armo el mini-plan de 3 pasos que te ofrecí.

¿Te lo mando esta semana?

Esto lo aprendemos juntos. — Alek`;

const DOLOR = 'El registro entra al CRM pero nadie lo pasa al listado, y el Excel de seguimiento nadie lo llena.';
const PROMESA = 'Alek le ofreció el mini-plan de 3 pasos en la bienvenida al beta (12-ago-2026). Si Elliot dice que sí, hay que entregarlo.';

(async () => {
  const { rows } = await pool.query(
    `SELECT MAX(created_at) AS ultimo,
            EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) / 3600 AS horas
       FROM coexistence.chat_history
      WHERE contact_number = $1 AND direction = 'incoming'`,
    [DESTINO]
  );
  const horas = rows[0]?.horas == null ? null : Number(rows[0].horas);
  if (horas == null) {
    console.error('ABORTA: no hay ningún mensaje entrante de ese número; no existe ventana de 24 h.');
    process.exit(1);
  }
  console.log(`  Último entrante: ${rows[0].ultimo.toISOString()} (hace ${horas.toFixed(2)} h)`);
  if (horas >= 24) {
    console.error(`ABORTA: fuera de la ventana de 24 h (${horas.toFixed(2)} h desde el último entrante). No se manda nada y NO se improvisa un template.`);
    process.exit(1);
  }
  console.log(`  Ventana abierta: quedan ${(24 - horas).toFixed(2)} h`);

  if (!fs.existsSync(IMAGEN)) {
    console.error(`ABORTA: no existe la imagen ${IMAGEN} dentro del contenedor.`);
    process.exit(1);
  }
  const bytes = fs.readFileSync(IMAGEN);
  console.log(`  Imagen: ${IMAGEN} (${Math.round(bytes.length / 1024)} KB)`);
  console.log(`  Destino: ${DESTINO}   Caption (${CAPTION.length} caracteres):\n`);
  console.log(CAPTION.split('\n').map(l => `    ${l}`).join('\n'));

  if (!APPLY) {
    console.log('\n  Dry-run: no se subió ni se envió nada. Corre con --apply.');
    process.exit(0);
  }

  const { account, error } = await resolveAccount({ fromPhoneNumber: WA_NUMBER });
  if (error) { console.error('ABORTA: no pude resolver la cuenta:', error); process.exit(1); }

  // Se sube el binario a Meta en vez de mandar `link`: no expone ningún URL público.
  const subida = await uploadMedia({
    accessToken: account.accessToken,
    phoneNumberId: account.phoneNumberId,
    buffer: bytes,
    mimeType: 'image/png',
    filename: 'bienvenida-elliot.png',
  });
  const mediaId = subida?.id;
  if (!mediaId) { console.error('ABORTA: Meta no devolvió media_id:', JSON.stringify(subida)); process.exit(1); }
  console.log(`\n  media_id = ${mediaId}`);

  const localMessageId = await insertPendingRow({
    account,
    toNumber: DESTINO,
    messageType: 'image',
    messageBody: CAPTION,
    templateMeta: {
      ux: 'ia360_100m',
      label: 'ia360_bienvenida_beta',
      source: 'script_bienvenida_beta',
      aprobado_por: 'alek',
      media_id: mediaId,
    },
  });
  if (!localMessageId) { console.error('ABORTA: la fila optimista no se insertó (dedupe).'); process.exit(1); }

  await enqueueSend({
    kind: 'media',
    accountId: account.id,
    to: DESTINO,
    localMessageId,
    payload: { type: 'image', mediaId, caption: CAPTION },
  });
  console.log(`  Encolado: local_message_id = ${localMessageId}`);

  // La promesa del texto («te armo el mini-plan de 3 pasos») entra al ledger para
  // que el digest la envejezca. Sin esta fila la promesa se evapora.
  const { rows: prom } = await pool.query(
    `INSERT INTO coexistence.ia360_bot_failures (contact_number, contact_message, reason, bot_fallback, status)
     VALUES ($1, $2, 'promesa_de_owner', $3, 'abierto') RETURNING id`,
    [DESTINO, DOLOR, PROMESA]
  );
  console.log(`  Promesa registrada en ia360_bot_failures id=${prom[0].id}`);
  console.log('\n  Listo. Verifica el status de la fila en chat_history en unos segundos.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
