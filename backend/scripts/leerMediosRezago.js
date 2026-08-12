// Lee los medios que se quedaron sin leer.
//
// Contexto (Alek, 12-ago-2026): el bot venía diciendo «no puedo escuchar audios /
// no puedo leer imágenes». Era falso —la capacidad existe en el stack— y el costo
// fue real: audios, capturas y archivos de champions acumulados desde junio que
// nadie procesó nunca. Desde hoy lo NUEVO se lee al llegar (mediaUnderstanding).
// Este script es para el REZAGO: recorre lo viejo y lo deja leído en la columna
// chat_history.media_lectura, que es de donde el agente y el ledger toman contexto.
//
// Los documentos (xlsx/csv/pdf) quedan fuera: el workflow de n8n resuelve imagen y
// audio. Los archivos son otra ronda.
//
//   docker exec forgecrm-backend node /app/scripts/leerMediosRezago.js
//   docker exec forgecrm-backend node /app/scripts/leerMediosRezago.js --apply
//   docker exec forgecrm-backend node /app/scripts/leerMediosRezago.js --apply --limit 5 --contacto 5213321060293

const pool = require('/app/src/db');
const { leerMedio } = require('/app/src/services/mediaUnderstanding');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const valorDe = (bandera, porDefecto) => {
  const i = args.indexOf(bandera);
  return i >= 0 && args[i + 1] ? args[i + 1] : porDefecto;
};
const LIMIT = parseInt(valorDe('--limit', '15'), 10) || 15;
const CONTACTO = valorDe('--contacto', '');

(async () => {
  const { rows } = await pool.query(
    `SELECT h.message_id, h.message_type, h.media_mime_type, h.media_size_bytes,
            h.contact_number, h.created_at::date AS fecha, c.name
       FROM coexistence.chat_history h
       LEFT JOIN LATERAL (SELECT name FROM coexistence.contacts
                           WHERE contact_number = h.contact_number
                           ORDER BY updated_at DESC LIMIT 1) c ON TRUE
      WHERE h.direction = 'incoming'
        AND h.media_status = 'stored'
        AND h.media_lectura IS NULL
        AND h.message_type IN ('audio', 'voice', 'image')
        AND h.contact_number !~ '^52199900[0-9]{5}$'
        AND ($1 = '' OR h.contact_number = $1)
      ORDER BY h.created_at
      LIMIT $2`,
    [CONTACTO, LIMIT]
  );

  if (!rows.length) { console.log('  No queda nada por leer.'); process.exit(0); }
  console.log(`  ${rows.length} medios sin leer${APPLY ? '' : ' (dry-run: no guarda nada)'}\n`);

  let ok = 0, fallos = 0;
  for (const r of rows) {
    const quien = String(r.name || r.contact_number).replace(/\s+WhatsApp IA360$/i, '');
    const fecha = r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha);
    const kb = Math.round((r.media_size_bytes || 0) / 1024);
    const t0 = Date.now();
    const res = await leerMedio({
      record: r,
      contexto: `${quien}, champion de Camiones Selectos escribiendo a Alek sobre su operación`,
    });
    const seg = ((Date.now() - t0) / 1000).toFixed(1);
    if (res.ok) {
      ok++;
      console.log(`  [OK ${seg}s] ${fecha} ${quien} · ${r.message_type}: ${res.texto.replace(/\s+/g, ' ').slice(0, 120)}…`);
    } else {
      fallos++;
      console.log(`  [FALLO ${seg}s] ${fecha} ${quien} · ${r.message_type}: ${res.motivo}`);
    }
  }
  console.log(`\n  leídos: ${ok}   fallidos: ${fallos}`);
  if (!APPLY) console.log('  Nada se guardó. Corre con --apply.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
