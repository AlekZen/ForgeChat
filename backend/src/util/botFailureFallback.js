'use strict';

// F1+F2 (auditoría WhatsApp 2026-08-12).
//
// El fallback de no-silencio era UN SOLO texto —"Recibí tu pregunta… te confirmo
// por aquí en breve"— para absolutamente todo. Daño medido en producción: 17
// promesas idénticas a Andrés (10-jul→31-jul), 9 a Juan Carlos, 3 a Germán;
// ninguna cumplida. Peor: la mayoría de esos mensajes eran audios, .xlsx y
// capturas de pantalla. El bot no puede procesarlos, así que prometía algo que
// nunca iba a poder hacer en lugar de decir la verdad y pedir el dato que sí
// puede leer.
//
// Regla nueva: el texto depende de (a) la CLASE de mensaje que llegó y (b) cuántas
// promesas abiertas arrastra ya ese contacto. La promesa se hace UNA vez; a partir
// de la segunda se reconoce el pendiente sin prometer de nuevo.
//
// Función pura a propósito: webhook.js no es importable en test (exige DB/Redis),
// y esta decisión de copy es justo lo que hay que blindar con aserciones reales.
function buildIa360BotFailureFallback({ record, openCount = 0 } = {}) {
  const type = String(record?.message_type || '').toLowerCase();

  if (type === 'audio' || type === 'voice') {
    return {
      body: 'Recibí tu audio. Todavía no puedo escuchar audios: ¿me escribes en una línea qué necesitas? Lo tomo de inmediato, o se lo paso a Alek tal cual.',
      reason: 'media_audio_no_soportado',
    };
  }

  if (type === 'document') {
    const nombre = String(record?.message_body || '').trim() || 'el archivo';
    return {
      body: `Recibí tu archivo «${nombre}». Se lo paso a Alek para que lo revise; si hay algo urgente del archivo, dímelo por aquí en texto.`,
      reason: 'media_documento_para_owner',
    };
  }

  if (type === 'image' || type === 'video' || type === 'sticker') {
    return {
      body: 'Recibí tu imagen. Aún no puedo leer imágenes: cuéntame en una línea qué muestra o qué necesitas y lo atiendo.',
      reason: 'media_imagen_no_soportada',
    };
  }

  // Texto (o cualquier clase sin tratamiento propio): la promesa solo la primera vez.
  if (Number(openCount) > 0) {
    return {
      body: 'Anotado: lo sumo a tus pendientes con Alek. Los anteriores ya se los recordé; no te dejo en visto.',
      reason: 'promesa_repetida_suprimida',
    };
  }

  return {
    body: 'Recibí tu pregunta. Para responderte bien y no darte una respuesta incompleta, voy a revisar el contexto con Alek y te confirmo por aquí en breve.',
    reason: 'texto_primera_promesa',
  };
}

module.exports = { buildIa360BotFailureFallback };
