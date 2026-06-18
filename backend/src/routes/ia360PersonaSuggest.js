// G13: sugerencia de PERSONA al capturar un contacto por vCard.
//
// Problema: cuando el owner comparte una vCard, `notifyOwnerVcardCaptured` le
// manda una lista de 10 personas PLANAS, sin pista. El owner tiene que cazar la
// correcta cada vez; como hace puro networking BNI casi siempre es
// "Referido / BNI", pero igual busca entre 10. Eso deja contactos sin clasificar.
//
// Las SECUENCIAS ya se rankean y marcan "Sugerida" (rankIa360Sequences). Aquí
// replicamos ESE patrón para las PERSONAS: a partir del nombre del vCard
// (`shared.name`) inferimos una persona probable, la subimos al TOPE de la lista
// y la marcamos "SUGERIDA". Es SOLO sugerencia: el owner sigue eligiendo con un
// tap; conservamos las 10 opciones y sus ids `owner_pipe:<num>:<persona>`.
//
// Módulo PURO (cero require/IO) → testeable sin deps externas.

'use strict';

// Normaliza a minúsculas y sin acentos para que el matcheo sea
// case/acento-insensible ("BNI" == "bni", "tesorería" == "tesoreria").
function normalizeName(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// Trunca respetando límites de la API de WhatsApp para list rows.
function compact(text, max) {
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// Señales de persona, en orden de prioridad. La PRIMERA que matchea gana.
// El orden importa cuando un nombre trae tokens de varias categorías; las
// señales más fuertes/específicas para el caso de Alek (BNI primero) van arriba.
// Todas las regex corren contra el nombre YA normalizado (minúsculas, sin acentos).
const PERSONA_SIGNALS = [
  // BNI / referidos: el caso dominante del owner. Muchos contactos traen "BNI"
  // literal en el nombre ("Carlos Chavez BNI Industrial", "Ing Jorge Samano BNI").
  { persona: 'persona_referido', reason: 'BNI / referido en el nombre', re: /\bbni\b|referid|recomend|me presento|\bintro\b/ },
  // Aliado / socio / canal / proveedor.
  { persona: 'persona_aliado', reason: 'socio / aliado en el nombre', re: /\bsocio\b|aliad|proveedor|\bcanal\b|partner/ },
  // CFO / finanzas / tesorería / contraloría.
  { persona: 'persona_cfo', reason: 'perfil finanzas / CFO', re: /\bcfo\b|finanz|contralor|tesoreri/ },
  // Director comercial / ventas. "comercial" después de "director comercial"
  // ya está cubierto por el token "comercial".
  { persona: 'persona_comercial', reason: 'perfil ventas / comercial', re: /director comercial|\bventas?\b|comercial/ },
  // Guardián técnico / sistemas / TI / tecnología. "ti"/"it" sueltos como token.
  { persona: 'persona_tecnico', reason: 'perfil técnico / sistemas', re: /\bcto\b|sistemas|tecnolog|\bti\b|\bit\b/ },
  // Sponsor ejecutivo: CEO / director general / dueño / fundador.
  { persona: 'persona_sponsor', reason: 'perfil ejecutivo / dueño', re: /\bceo\b|directora? general|\bduen[oa]\b|fundador/ },
];

// Devuelve { persona, reason } con la persona sugerida, o null si no hay señal
// clara (mejor SIN sugerencia que una mala). `persona` es uno de los ids
// `persona_*`; `reason` es una razón corta para mostrar en la lista.
function suggestIa360Persona(shared) {
  const text = normalizeName(shared && shared.name);
  if (!text.trim()) return null;
  for (const rule of PERSONA_SIGNALS) {
    if (rule.re.test(text)) return { persona: rule.persona, reason: rule.reason };
  }
  return null;
}

// Definición base de las 10 filas de la lista de clasificación, en el MISMO
// orden y con los MISMOS ids/títulos/descripciones que mandaba el callsite hoy.
// `key` es el sufijo del id `owner_pipe:<num>:<key>` del que depende el dispatch.
const VCARD_PERSONA_ROWS = [
  { key: 'persona_beta', title: 'Beta / amigo', description: 'Técnico, conocido o prueba' },
  { key: 'persona_referido', title: 'Referido / BNI', description: 'Intro o recomendación' },
  { key: 'persona_aliado', title: 'Aliado / socio', description: 'Canal o proveedor' },
  { key: 'persona_cliente', title: 'Cliente activo', description: 'Engage o deleitar' },
  { key: 'persona_sponsor', title: 'Sponsor ejecutivo', description: 'Buyer o dueño' },
  { key: 'persona_comercial', title: 'Director comercial', description: 'Ventas o pipeline' },
  { key: 'persona_cfo', title: 'CFO / finanzas', description: 'Control, datos o dinero' },
  { key: 'persona_tecnico', title: 'Guardián técnico', description: 'Integración o permisos' },
  { key: 'guardar', title: 'Solo guardar', description: 'Captura sin envío' },
  { key: 'excluir', title: 'No contactar', description: 'Exclusión sin envío' },
];

// Construye las filas de la lista de WhatsApp. Si `suggestion` trae una persona,
// REORDENA esa fila al TOPE y la marca "SUGERIDA · ..." en la descripción
// (title intacto, <=24; description compactada a <=72). Conserva SIEMPRE las 10
// filas y sus ids; sin sugerencia la lista queda EXACTAMENTE como hoy.
function buildVcardPersonaRows({ contactNumber, suggestion } = {}) {
  const rows = VCARD_PERSONA_ROWS.map(r => ({
    id: `owner_pipe:${contactNumber}:${r.key}`,
    title: compact(r.title, 24),
    description: compact(r.description, 72),
  }));
  const persona = suggestion && suggestion.persona;
  if (!persona) return rows;
  const wantedId = `owner_pipe:${contactNumber}:${persona}`;
  const idx = rows.findIndex(r => r.id === wantedId);
  if (idx === -1) return rows; // persona desconocida → no tocamos la lista.
  const [picked] = rows.splice(idx, 1);
  picked.description = compact(`SUGERIDA · ${picked.description}`, 72);
  rows.unshift(picked);
  return rows;
}

// ============================================================================
// G-FIX4: detector de CONFLICTO DE TONO. Un contacto puede traer a la vez una
// señal de CANAL (BNI/referido en el nombre → persona_referido) y una señal de
// RELACION PERSONAL (token "amig"/"beta" en el nombre, o el flag tono_personal
// que dejó el comando "intro" cuando el owner describió una relación). Ante esa
// doble señal NO auto-elegimos: el sistema PREGUNTA el tono (decisión de Alek).
// Módulo PURO: estas funciones no hacen IO; webhook.js orquesta la tarjeta.
// ============================================================================

// True si el NOMBRE del vCard trae una señal de relación personal cálida
// ("amig*" o "beta"). Corre sobre el nombre YA normalizado (sin acentos).
function hasRelationshipSignalInName(name) {
  const t = normalizeName(name);
  if (!t.trim()) return false;
  return /\bamig[oa]s?\b|\bbeta\b/.test(t);
}

// True si hay señal de CANAL referido/BNI en el nombre (misma regla que la
// señal persona_referido de PERSONA_SIGNALS, aislada para el detector de tono).
function hasChannelSignalInName(name) {
  const t = normalizeName(name);
  if (!t.trim()) return false;
  return /\bbni\b|referid|recomend|me presento|\bintro\b/.test(t);
}

// Detecta el conflicto de tono. Recibe el nombre del vCard y, opcionalmente, el
// flag de relación personal persistido (tono_personal, del comando intro).
//   channel  = señal BNI/referido en el nombre
//   personal = "amig"/"beta" en el nombre  OR  relationPersonalFlag===true
// Devuelve { conflict, channel, personal }. conflict === true SOLO si ambas.
function detectIa360ToneConflict({ name, relationPersonalFlag = false } = {}) {
  const channel = hasChannelSignalInName(name);
  const personal = hasRelationshipSignalInName(name) || relationPersonalFlag === true;
  return { conflict: Boolean(channel && personal), channel, personal };
}

module.exports = {
  suggestIa360Persona,
  buildVcardPersonaRows,
  VCARD_PERSONA_ROWS,
  normalizeName,
  hasRelationshipSignalInName,
  hasChannelSignalInName,
  detectIa360ToneConflict,
};
