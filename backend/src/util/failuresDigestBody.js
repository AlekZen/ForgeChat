'use strict';

// Copy del digest de promesas abiertas que va al WhatsApp del owner.
//
// Vive aquí y no en services/botFailuresDigest.js por una razón práctica: el
// servicio arrastra pool de Postgres y la cola de Redis, así que no es importable
// en test. El texto que ve Alek sí debe estar blindado con aserciones reales.

function truncar(texto, max) {
  const limpio = String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
  if (!limpio) return '(sin texto)';
  return limpio.length <= max ? limpio : limpio.slice(0, max - 1).trimEnd() + '…';
}

function dias(desde) {
  const ms = Date.now() - new Date(desde).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `hace ${d} día${d === 1 ? '' : 's'}`;
  const h = Math.max(1, Math.floor(ms / 3600000));
  return `hace ${h} h`;
}

// F8 (auditoría 2026-08-12): el digest detallaba 5 filas y encabezaba "Tienes 5
// promesas sin cerrar" mientras el backlog real era de 31 — el owner creía ir al
// corriente. `totalAbiertas` es el conteo completo de vencidas; cuando supera al
// detalle, se declara explícitamente.
function buildDigestBody(filas, totalAbiertas = 0) {
  const lineas = filas.map(f => {
    const quien = String(f.name || '').replace(/\s+WhatsApp IA360$/i, '').trim() || f.contact_number;
    // El folio hace accionable la línea: el owner sabe en qué ticket va sin buscarlo.
    const folio = f.plane_issue_key ? `${f.plane_issue_key}, ` : '';
    return `• ${quien}: «${truncar(f.contact_message, 90)}» (${folio}${dias(f.created_at)})`;
  });
  const total = Number(totalAbiertas) || 0;
  const pie = total > filas.length
    ? [`En total llevas ${total} promesas abiertas; te voy pasando el resto en los siguientes digests.`]
    : [];
  return [
    `Tienes ${filas.length} promesa${filas.length === 1 ? '' : 's'} de respuesta sin cerrar (les dije "te confirmo por aquí en breve" hace más de 24 h):`,
    '',
    ...lineas,
    '',
    ...pie,
    'No les he escrito nada más: el cierre lo decides tú. Responde en su hilo o tómalo manual.',
  ].join('\n');
}

module.exports = { buildDigestBody, truncar, dias };
