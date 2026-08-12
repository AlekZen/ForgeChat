// Triaje de desconocidos: quién es el que acaba de escribir y qué hacemos con él.
//
// POR QUÉ EXISTE (Alek, 12-ago-2026): al WhatsApp de IA360 le escribe gente que no
// está en ningún embudo — clientes potenciales, proveedores, gente que vende cursos,
// reclutadores, aliados. Hasta hoy TODOS quedaban mudos: `handleIa360FreeText` hacía
// `if (!deal) return`. Medido en la base: 4 desconocidos en 90 días sin una sola
// respuesta; el último (5213317399146) escribió tres veces el 12-ago y nadie le
// contestó nunca. Un desconocido ignorado es un cliente que no volverá a escribir, y
// además no sabemos qué se perdió.
//
// Qué hace este módulo: es SÓLO decisión, sin efectos. Recibe el texto y el turno, y
// devuelve (a) de qué se trata, (b) qué se le contesta —una sola pregunta, sin pitch
// y sin prometer nada que no quede en el ledger— y (c) si hay que interrumpir a Alek
// con una tarjeta o basta con dejarlo anotado. El cableado (enviar, guardar estado,
// escribir el ledger) vive en webhook.js, que es quien tiene esas herramientas.
//
// Por qué NO usa un modelo: este carril le habla a extraños, así que la respuesta
// tiene que ser predecible, corta y auditable, sin depender de que n8n conteste.
// El clasificador es de señales explícitas y falla hacia `indeterminado`, que es el
// caso en que precisamente se PREGUNTA en vez de suponer.

'use strict';

// Tope de mensajes automáticos por desconocido. Tres es: sondeo, respuesta a lo que
// contestó, y nada más. A partir de ahí contesta un humano o no contesta nadie: una
// conversación infinita con un desconocido es exactamente el ruido que no queremos.
const TRIAJE_MAX_MENSAJES = 3;

const TIPOS = [
  'cliente_potencial',
  'propuesta_alianza',
  'proveedor',
  'marketing_masivo',
  'reclutamiento',
  'indeterminado',
];

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Señales por tipo. El orden de evaluación importa y está razonado abajo, en
// clasificarDesconocido: la demanda en primera persona gana siempre, porque «quiero
// capacitación para mi equipo» es un cliente y «son 8 horas de capacitación» es
// alguien vendiendo un curso, y las dos frases comparten la palabra.
const SENALES = {
  cliente_potencial: [
    /\b(cotiza(cion|r)?|presupuesto|cuanto (cuesta|cobra|vale)|precio(s)?)\b/,
    /\b(quiero|necesito|busco|me interesa|nos urge|requiero|estoy buscando)\b[^.?!]{0,60}\b(automatizar|implementar|sistema|crm|whatsapp|agente|bot|ia|inteligencia artificial|ayuda|apoyo|solucion|servicio|asesoria|capacitacion|consultoria)\b/,
    /\b(tenemos|tengo) (un )?(problema|bronca|lio|reto|pedo)\b/,
    /\b(me (lo )?recomendo|me paso tu (numero|contacto)|vengo de parte de)\b/,
    /\b(contratar|trabajar contigo|que nos apoyes|nos ayudes)\b/,
  ],
  propuesta_alianza: [
    /\b(alianza|aliarnos|colabora(r|cion)|socio(s)?|partner(s)?|sinergia)\b/,
    /\b(referir(te)?|referidos|pasarte clientes|recomendarte)\b/,
    /\b(bni|capitulo|networking)\b/,
    /\b(trabajar juntos|hacer algo juntos|unir fuerzas)\b/,
  ],
  reclutamiento: [
    /\b(vacante(s)?|empleo|reclut(a|amiento)|contratacion de personal)\b/,
    /\b(cv|curriculum|hoja de vida|postular(me)?|solicitud de trabajo)\b/,
    /\b(busco (trabajo|chamba)|estoy buscando (trabajo|empleo))\b/,
  ],
  marketing_masivo: [
    /\b(promocion|descuento|oferta especial|precio especial|cupo(s)? limitado(s)?)\b/,
    /\b(inscribete|registrate|no te lo pierdas|ultimos lugares|aparta tu lugar)\b/,
    /\b(webinar|diplomado|masterclass|taller|curso|conferencia|evento)\b/,
    /\b(son \d+ horas|\d+ horas de (capacitacion|curso|entrenamiento))\b/,
    /\b(envio(s)? masivo(s)?|base de datos de clientes|leads garantizados)\b/,
  ],
  proveedor: [
    /\b(ofrecemos|le ofrezco|te ofrezco|ofrezco|manejamos|vendemos|distribuimos)\b/,
    /\b(somos (una )?(empresa|agencia|despacho|fabrica|distribuidor)|represento a)\b/,
    /\b(nuestros (servicios|productos|precios)|nuestra empresa|mi empresa se dedica)\b/,
    /\b(proveedor|cotizamos|le cotizo|catalogo)\b/,
    /\b(buscabas|estabas buscando|te interesa(ria)?)\b[^.?!]{0,40}\b(asesoria|servicio|curso|capacitacion|solucion)\b/,
  ],
};

/**
 * De qué se trata el mensaje de un desconocido.
 *
 * `textoPrevio` acumula lo que ya había dicho: alguien que saluda y en el segundo
 * mensaje dice a qué viene sólo se entiende leyendo los dos.
 *
 * @returns {{tipo: string, confianza: number, senales: string[]}}
 */
function clasificarDesconocido({ texto, textoPrevio = '' } = {}) {
  const t = normalizar(`${textoPrevio || ''} ${texto || ''}`);
  if (!t) return { tipo: 'indeterminado', confianza: 0, senales: [] };

  const marcadas = {};
  for (const tipo of Object.keys(SENALES)) {
    const hits = SENALES[tipo].filter(re => re.test(t));
    if (hits.length) marcadas[tipo] = hits.length;
  }

  // Precedencia razonada, no alfabética:
  //  1. cliente_potencial — la demanda en primera persona manda sobre cualquier otra
  //     señal: es el caso caro de equivocarse (mandar a un cliente al cajón de spam).
  //  2. propuesta_alianza — un aliado también trae valor y no se le contesta como
  //     proveedor.
  //  3. reclutamiento — inconfundible y no se atiende por este canal.
  //  4. marketing_masivo — antes que proveedor: quien manda un flyer usa las dos
  //     familias de palabras y el trato correcto es cerrar, no preguntarle qué vende.
  //  5. proveedor.
  const orden = ['cliente_potencial', 'propuesta_alianza', 'reclutamiento', 'marketing_masivo', 'proveedor'];
  for (const tipo of orden) {
    if (marcadas[tipo]) {
      return { tipo, confianza: Math.min(1, 0.5 + 0.25 * marcadas[tipo]), senales: Object.keys(marcadas) };
    }
  }
  return { tipo: 'indeterminado', confianza: 0, senales: [] };
}

function saludo(nombre, presentarse) {
  const quien = String(nombre || '').trim().split(/\s+/)[0] || '';
  if (!presentarse) return quien ? `${quien}, ` : '';
  const hola = quien ? `Hola, ${quien}.` : 'Hola.';
  return `${hola} Soy Alekito, el asistente de Alek Orozco. `;
}

// Una respuesta por tipo. Reglas que valen para todas: una sola pregunta, nada de
// pitch, ningún dato inventado y ninguna promesa que no quede registrada en el
// ledger por el llamador.
const RESPUESTAS = {
  indeterminado: ({ nombre, presentarse }) =>
    `${saludo(nombre, presentarse)}Te leo y se lo paso a Alek. Para que le llegue completo y no tengas que repetirlo: ¿de qué se trata — necesitas algo para tu empresa, me ofreces un servicio o es otra cosa?`,

  cliente_potencial: ({ nombre, presentarse }) =>
    `${saludo(nombre, presentarse)}Entendido, esto se lo paso a Alek hoy y él te contesta por aquí. Para que llegue con lo importante: ¿qué es lo que hoy te está costando tiempo o dinero?`,

  propuesta_alianza: ({ nombre, presentarse }) =>
    `${saludo(nombre, presentarse)}Gracias por buscarlo, se lo paso a Alek. Para que lo vea con contexto: ¿qué tienes en mente y a quién atiendes tú hoy?`,

  proveedor: ({ nombre, presentarse }) =>
    `${saludo(nombre, presentarse)}Gracias por escribir. Alek revisa proveedores por temporadas, así que no te prometo tiempos. ¿Qué ofreces exactamente, en una línea?`,

  marketing_masivo: ({ nombre, presentarse }) =>
    `${saludo(nombre, presentarse)}Gracias, pero no es algo que estemos buscando por ahora. Dejo tu mensaje anotado y si cambia, Alek te busca.`,

  reclutamiento: ({ nombre, presentarse }) =>
    `${saludo(nombre, presentarse)}Por aquí no se manejan vacantes ni contrataciones, así que no te dejo esperando: le dejo tu mensaje a Alek y, si aplica, él te escribe.`,
};

// Qué hacer con cada tipo: a quién interrumpimos y con qué urgencia.
//   'card'   → tarjeta al owner con botones (Lo tomo / Responder / Ignorar). Sólo
//              para lo que puede costar dinero si se cae: cliente y aliado.
//   'ledger' → fila anotada que el digest envejece, sin interrumpir el teléfono.
//   'ledger_cerrado' → queda el registro pero nace cerrado: no es un pendiente.
const ESCALAMIENTO = {
  cliente_potencial: 'card',
  propuesta_alianza: 'card',
  indeterminado: 'ledger',
  proveedor: 'ledger',
  reclutamiento: 'ledger',
  marketing_masivo: 'ledger_cerrado',
};

/**
 * Decisión completa de un turno de triaje.
 *
 * @param {object} p
 * @param {string} p.tipo        - salida de clasificarDesconocido
 * @param {string} p.nombre      - cómo llamarle (perfil de WhatsApp o nombre en CRM)
 * @param {number} p.turno       - 1 = primer mensaje suyo que atendemos
 * @param {boolean} p.hayTexto   - false si sólo mandó un medio sin nada escrito
 * @returns {{responder: boolean, cuerpo: string|null, escalar: string|null,
 *            estado: string, motivo: string}}
 */
function decidirTriaje({ tipo, nombre = '', turno = 1, hayTexto = true } = {}) {
  const tipoFinal = TIPOS.includes(tipo) ? tipo : 'indeterminado';

  // Tope duro: a partir del cuarto mensaje ya no contesta el bot. Si sigue abierto,
  // que lo cierre una persona.
  if (turno > TRIAJE_MAX_MENSAJES) {
    return {
      responder: false,
      cuerpo: null,
      escalar: 'ledger',
      estado: 'cerrado',
      motivo: 'limite_de_mensajes_automaticos',
    };
  }

  // Un medio sin una sola palabra: no se supone de qué se trata, se pregunta. Y no
  // se le dice «no puedo verlo» —eso ya fue un defecto—, simplemente se pregunta.
  if (!hayTexto) {
    return {
      responder: true,
      cuerpo: `${saludo(nombre, turno === 1)}Recibí lo que mandaste y se lo paso a Alek. ¿Me cuentas en una línea de qué se trata?`,
      escalar: 'ledger',
      estado: 'sondeado',
      motivo: 'medio_sin_texto',
    };
  }

  // Segundo turno y seguimos sin entender de qué se trata: no se pregunta dos veces
  // lo mismo (es justo lo que cansa). Se le dice la verdad y se escala a Alek.
  if (tipoFinal === 'indeterminado' && turno > 1) {
    return {
      responder: true,
      cuerpo: `${saludo(nombre, false)}Se lo paso a Alek tal cual me lo escribiste; él te contesta por aquí.`,
      escalar: 'card',
      estado: 'escalado',
      motivo: 'sigue_sin_clasificar',
    };
  }

  const escalar = ESCALAMIENTO[tipoFinal];
  return {
    responder: true,
    cuerpo: RESPUESTAS[tipoFinal]({ nombre, presentarse: turno === 1 }),
    escalar,
    estado: escalar === 'card' ? 'escalado' : (escalar === 'ledger_cerrado' ? 'silenciado' : 'sondeado'),
    motivo: `tipo_${tipoFinal}`,
  };
}

module.exports = {
  TRIAJE_MAX_MENSAJES,
  TIPOS,
  clasificarDesconocido,
  decidirTriaje,
};
