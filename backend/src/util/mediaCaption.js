'use strict';

// Incidente Andrés, 12-ago-2026 17:41.
//
// Mandó una CAPTURA de pantalla con todo su pedido escrito en el pie de foto:
// «quedó bien el Mapa ejecutivo de sistemas, me gustaría ver cuál fue la última
// fecha de actualización… he intentado cargar el plan piso desde el 22 de julio y
// me señala un error, te lo he hecho saber compartiendo imagen y no me has podido
// apoyar resolverlo…». El router sólo dejaba pasar `message_type === 'text'`, así
// que ese mensaje nunca llegó al agente y el invariante de no-silencio contestó
// «no puedo leer imágenes: cuéntame en una línea qué necesitas» — exactamente lo
// que él estaba reclamando.
//
// Una imagen CON pie de foto es un mensaje de texto que además trae una imagen.
// Este helper devuelve ese texto cuando existe, y null cuando de verdad no hay
// nada que leer (imagen suelta, sticker, audio, o un documento —donde
// `message_body` es el NOMBRE DEL ARCHIVO, no algo que el contacto escribió—).

// Placeholders que pone parseMessage cuando no hubo texto real del contacto.
const PLACEHOLDERS = new Set(['audio message', 'voice message', 'sticker', 'interactive response', 'button response']);

// Un pie de foto útil trae una petición, no un «mira» suelto. El umbral es corto a
// propósito: «no carga el plan piso» son 21 caracteres y es una petición completa.
const MIN_CARACTERES = 12;

function ia360MediaCaption(record) {
  const tipo = String(record?.message_type || '').toLowerCase();
  if (tipo !== 'image' && tipo !== 'video') return null;
  const texto = String(record?.message_body || '').trim();
  if (!texto || texto.length < MIN_CARACTERES) return null;
  if (PLACEHOLDERS.has(texto.toLowerCase())) return null;
  return texto;
}

module.exports = { ia360MediaCaption, MIN_CARACTERES };
