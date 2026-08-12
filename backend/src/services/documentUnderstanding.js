// Lectura de documentos: los Excel, CSV y textos que mandan los contactos.
//
// POR QUÉ EXISTE (Alek, 12-ago-2026): la lectura de medios ya resolvió imagen y
// audio (mediaUnderstanding.js → n8n con visión/transcripción), pero los ARCHIVOS
// seguían huérfanos: de `document` sólo se guardaba el NOMBRE del archivo y nadie
// abría el contenido. Andrés mandó su Excel de seguimiento y el sistema respondió
// como si no existiera.
//
// Cómo funciona: el archivo YA está en disco (mediaDownloader lo baja de Meta al
// llegar). Aquí se parsea LOCALMENTE con exceljs —la misma librería y el mismo
// patrón que ya usa la importación de `routes/messages.js`— y el resumen en
// español se guarda en chat_history.media_lectura, exactamente igual que hacen los
// medios. No viaja a n8n: no hace falta un modelo para leer una hoja de cálculo, y
// no mandar el archivo fuera es además la opción segura.
//
// AISLAMIENTO: este servicio nunca lee ni escribe las tablas de memoria de IA360.
// Lo que produce se guarda en la fila del mensaje, que ya es por contacto.
//
// Alcance deliberado: xlsx/xlsm/xls, csv y texto plano. PDF y DOCX devuelven
// `formato_no_parseable` — son 1 y 1 en todo el histórico y no vale una librería
// más; el acuse honesto que ya existe los cubre.
//
// Falla en abierto: cualquier problema devuelve { ok:false, motivo } y el llamador
// sigue con el camino de siempre. Nunca lanza, nunca deja mudo a un contacto.

const fs = require('fs');
const { Readable } = require('node:stream');
const ExcelJS = require('exceljs');

const pool = require('../db');
const { esperarArchivo } = require('./mediaUnderstanding');

// Un Excel de 10 MB ya es un volcado, no un mensaje: parsearlo cuesta memoria en
// el proceso que atiende el webhook y su resumen no cabría en el contexto igual.
const MAX_BYTES = parseInt(process.env.IA360_DOC_READ_MAX_BYTES || '', 10) || 10 * 1024 * 1024;
const MAX_CHARS = 4000;
const MAX_HOJAS = 3;
const MAX_FILAS_MUESTRA = 10;

// En minúsculas: el mime que manda WhatsApp trae mayúsculas («…macroEnabled.12»)
// y se compara normalizado. Sin esto el xlsm caía en «formato_no_parseable».
const MIMES_HOJA = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel.sheet.macroenabled.12',                    // xlsm
  'application/vnd.ms-excel',                                          // xls
]);

// Copia deliberada de routes/messages.js: un servicio no importa de routes/
// (misma regla que ya documenta botFailuresDigest.js).
function cellToString(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.hyperlink ?? '').trim();
  return String(v).trim();
}

// Saneado antes de guardar: un .txt exportado de Word llega en UTF-16 y, mal
// decodificado, mete NUL en el texto — Postgres rechaza la fila entera con
// «invalid byte sequence for encoding UTF8: 0x00» y la lectura se perdía en
// silencio (ok:true sin nada guardado).
function recortar(texto) {
  const t = String(texto || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .trim();
  return t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)} […recortado]` : t;
}

// Texto plano: WhatsApp entrega .txt tal cual lo guardó el usuario, y Windows
// exporta en UTF-16 con BOM. Leerlo como utf8 devuelve un galimatías; se decide
// por el BOM y sólo si no hay se asume utf8.
function decodificarTexto(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return buffer.slice(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return buffer.slice(2).swap16().toString('utf16le'); // UTF-16 big-endian
  }
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.slice(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

// Resumen legible de una hoja: encabezados + hasta 10 filas de muestra. El agente
// necesita saber DE QUÉ trata el archivo y con qué columnas, no reproducirlo.
function resumirHoja(ws) {
  const lineas = [];
  const filas = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (filas.length > MAX_FILAS_MUESTRA) return;
    const vals = row.values; // 1-indexed; vals[0] es undefined
    const celdas = [];
    for (let i = 1; i < vals.length; i++) celdas.push(cellToString(vals[i]));
    if (celdas.some(c => c !== '')) filas.push(celdas);
  });
  const columnas = filas.reduce((max, f) => Math.max(max, f.length), 0);
  lineas.push(`Hoja «${ws.name}» (${ws.rowCount} filas × ${columnas} columnas)`);
  if (filas.length) {
    lineas.push(`Encabezados: ${filas[0].join(' | ')}`);
    for (const f of filas.slice(1, 1 + MAX_FILAS_MUESTRA)) lineas.push(f.join(' | '));
  }
  return lineas.join('\n');
}

async function leerDocumento({ record }) {
  if (!record?.message_id) return { ok: false, tipo: 'documento', motivo: 'tipo_no_leible' };

  const fila = await esperarArchivo(record.message_id).catch(() => null);
  if (!fila) return { ok: false, tipo: 'documento', motivo: 'archivo_no_disponible' };

  const mime = String(fila.media_mime_type || record.media_mime_type || '').toLowerCase().split(';')[0].trim();
  const esHoja = MIMES_HOJA.has(mime);
  const esCsv = mime === 'text/csv';
  const esTexto = mime === 'text/plain';
  if (!esHoja && !esCsv && !esTexto) return { ok: false, tipo: 'documento', motivo: 'formato_no_parseable' };

  let tamano = Number(record.media_size_bytes) || 0;
  try { tamano = fs.statSync(fila.media_storage_path).size; } catch { /* se queda con el de la fila */ }
  if (tamano > MAX_BYTES) return { ok: false, tipo: 'documento', motivo: 'archivo_muy_grande' };

  let texto = '';
  try {
    if (esTexto) {
      texto = decodificarTexto(fs.readFileSync(fila.media_storage_path)).slice(0, MAX_CHARS);
    } else {
      const buffer = fs.readFileSync(fila.media_storage_path);
      const wb = new ExcelJS.Workbook();
      let hojas;
      if (esCsv) {
        const ws = await wb.csv.read(Readable.from(buffer));
        hojas = ws ? [ws] : [];
      } else {
        await wb.xlsx.load(buffer);
        hojas = wb.worksheets.slice(0, MAX_HOJAS);
      }
      if (!hojas.length) return { ok: false, tipo: 'documento', motivo: 'archivo_vacio' };
      texto = hojas.map(resumirHoja).join('\n\n');
    }
  } catch (e) {
    console.error('[doc-lectura] no pude parsear %s (%s): %s', record.message_id, mime, e.message);
    return { ok: false, tipo: 'documento', motivo: 'error_de_parseo' };
  }

  texto = recortar(texto);
  if (!texto) return { ok: false, tipo: 'documento', motivo: 'lectura_vacia' };

  await pool.query(
    `UPDATE coexistence.chat_history SET media_lectura = $2 WHERE message_id = $1`,
    [record.message_id, texto]
  ).catch(e => console.error('[doc-lectura] no pude guardar la lectura:', e.message));

  console.log('[doc-lectura] documento leído (%d chars) de %s', texto.length, record.message_id);
  return { ok: true, tipo: 'documento', texto };
}

module.exports = { leerDocumento };
