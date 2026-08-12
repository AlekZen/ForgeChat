// Lectura de medios: audios, capturas e imágenes que mandan los contactos.
//
// POR QUÉ EXISTE (Alek, 12-ago-2026): el bot venía contestando «no puedo escuchar
// audios» / «no puedo leer imágenes». Eso era falso: la capacidad existe en el
// stack —las credenciales de OpenAI viven en n8n, y agénticamente llevamos meses
// leyendo imágenes y transcribiendo audio—. Lo que faltaba era el cable. Decir «no
// puedo» cuando sí se puede es una mentira operativa que además deja al champion
// sin respuesta: Andrés mandó 4 audios y 5 archivos entre junio y agosto y nadie
// los oyó nunca.
//
// Cómo funciona: el archivo YA está en disco (mediaDownloader lo baja de Meta al
// llegar, y transcodifica las notas de voz Ogg/Opus a MP3 con ffmpeg). Este
// servicio lo manda en base64 al workflow de n8n «IA360 · Lectura de medios», que
// resuelve con visión (capturas) o transcripción (voz), y guarda el texto en
// chat_history.media_lectura para que el agente, el ledger y el digest vean lo que
// el contacto realmente dijo en vez de «Audio message».
//
// Falla en abierto: si n8n no responde, se devuelve { ok:false } y el llamador
// sigue con el camino de siempre. Nunca deja mudo a un contacto.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pexecFile = promisify(execFile);
const pool = require('../db');

const URL_LECTURA = process.env.N8N_IA360_MEDIA_READ_URL
  || 'https://n8n.geekstudio.dev/webhook/ia360-lectura-medios';
// Visión ~7 s y transcripción ~5 s medidos con archivos reales de Andrés. El
// invariante de no-silencio dispara a los 75 s: 30 s deja margen de sobra.
const TIMEOUT_MS = parseInt(process.env.IA360_MEDIA_READ_TIMEOUT_MS || '', 10) || 30000;
// WhatsApp permite hasta 16 MB; en base64 eso son ~21 MB de JSON. Por arriba de
// 8 MB el viaje deja de valer la pena y se degrada al aviso honesto.
const MAX_BYTES = parseInt(process.env.IA360_MEDIA_READ_MAX_BYTES || '', 10) || 8 * 1024 * 1024;

const TIPO_POR_MENSAJE = { image: 'imagen', video: 'imagen', audio: 'audio', voice: 'audio' };

function tipoDeLectura(messageType) {
  return TIPO_POR_MENSAJE[String(messageType || '').toLowerCase()] || null;
}

// El archivo se descarga en segundo plano al recibir el webhook, así que puede no
// estar listo el primer instante. Se espera un poco en vez de rendirse.
async function esperarArchivo(messageId, intentos = 8, esperaMs = 1500) {
  for (let i = 0; i < intentos; i++) {
    const { rows } = await pool.query(
      `SELECT media_storage_path, media_status, media_mime_type
         FROM coexistence.chat_history WHERE message_id = $1 LIMIT 1`,
      [messageId]
    );
    const fila = rows[0];
    if (fila?.media_storage_path && fs.existsSync(fila.media_storage_path)) return fila;
    if (fila?.media_status === 'error') return null;
    await new Promise(r => setTimeout(r, esperaMs));
  }
  return null;
}

async function leerMedio({ record, contexto = '' }) {
  const tipo = tipoDeLectura(record?.message_type);
  if (!tipo || !record?.message_id) return { ok: false, motivo: 'tipo_no_leible' };

  const fila = await esperarArchivo(record.message_id).catch(() => null);
  if (!fila) return { ok: false, motivo: 'archivo_no_disponible' };

  // NORMALIZACIÓN DE AUDIO. Whisper acepta m4a en teoría, pero un .m4a de 4.5 min
  // que WhatsApp entrega como audio/mp4 se rechazó con «Invalid file format».
  // En vez de adivinar contenedores, se transcodifica todo audio a MP3 mono 32 kbps
  // con el ffmpeg que ya vive en la imagen: formato probado extremo a extremo y una
  // fracción del peso (4.4 MB → ~1 MB), lo que además abarata el viaje a n8n.
  let rutaFinal = fila.media_storage_path;
  let mimeFinal = fila.media_mime_type || record.media_mime_type || (tipo === 'audio' ? 'audio/mpeg' : 'image/jpeg');
  let temporal = null;
  if (tipo === 'audio' && !/^audio\/mpeg$/i.test(mimeFinal)) {
    temporal = path.join(os.tmpdir(), `ia360-lectura-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);
    try {
      await pexecFile('ffmpeg', ['-y', '-i', fila.media_storage_path, '-vn', '-ac', '1', '-b:a', '32k', temporal], { timeout: 60000 });
      rutaFinal = temporal;
      mimeFinal = 'audio/mpeg';
    } catch (e) {
      console.error('[media-lectura] ffmpeg no pudo normalizar (sigo con el original):', e.message);
      temporal = null;
    }
  }

  let bytes;
  try {
    bytes = fs.readFileSync(rutaFinal);
  } catch (e) {
    console.error('[media-lectura] no pude leer el archivo:', e.message);
    if (temporal) fs.unlink(temporal, () => {});
    return { ok: false, motivo: 'archivo_ilegible' };
  }
  if (temporal) fs.unlink(temporal, () => {});
  if (bytes.length > MAX_BYTES) return { ok: false, motivo: 'archivo_muy_grande' };

  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_LECTURA, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tipo,
        mime: mimeFinal,
        base64: bytes.toString('base64'),
        contexto: String(contexto || '').slice(0, 400),
      }),
      signal: control.signal,
    });
    if (!res.ok) {
      console.error('[media-lectura] n8n respondió %s', res.status);
      return { ok: false, motivo: `n8n_${res.status}` };
    }
    const cuerpo = await res.json().catch(() => ({}));
    const texto = String(cuerpo?.texto || '').trim();
    if (!texto) return { ok: false, motivo: 'lectura_vacia' };

    await pool.query(
      `UPDATE coexistence.chat_history SET media_lectura = $2 WHERE message_id = $1`,
      [record.message_id, texto]
    ).catch(e => console.error('[media-lectura] no pude guardar la lectura:', e.message));

    console.log('[media-lectura] %s leído (%d chars) de %s', tipo, texto.length, record.message_id);
    return { ok: true, tipo, texto };
  } catch (e) {
    console.error('[media-lectura] fallo:', e.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : e.message);
    return { ok: false, motivo: 'error_de_red' };
  } finally {
    clearTimeout(reloj);
  }
}

// Texto efectivo del mensaje: lo que el contacto escribió (pie de foto) MÁS lo que
// dice el medio. Para una nota de voz el pie no existe y la transcripción es todo.
function componerMensajeConLectura({ record, lectura }) {
  const escrito = String(record?.message_body || '').trim();
  const esPlaceholder = /^(audio message|voice message|sticker)$/i.test(escrito);
  const partes = [];
  if (escrito && !esPlaceholder) partes.push(escrito);
  if (lectura?.ok && lectura.texto) {
    partes.push(lectura.tipo === 'audio'
      ? `[transcripción de su nota de voz] ${lectura.texto}`
      : `[lo que se ve en la imagen que mandó] ${lectura.texto}`);
  }
  return partes.join('\n\n');
}

module.exports = { leerMedio, componerMensajeConLectura, tipoDeLectura };
