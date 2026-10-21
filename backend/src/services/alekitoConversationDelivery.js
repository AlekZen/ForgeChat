'use strict';
const P=require('./alekitoBridgePolicy');

function formatExecutiveWhatsApp(rawText) {
  if (typeof rawText !== 'string') return '';
  let s = rawText.trim();
  s = s
    .replace(/^Con el contexto reciente disponible,\s*/i, '')
    .replace(/Desde este chat no puedo (?:editar|aplicar|detonar|ejecutar|modificar|enviar)[^.\n]*;\s*esa\s+([^.\n]+)\./gi, '¡Con gusto te ayudo a impulsarlo! Yo lo dejo preparado en Misión Control para que $1.')
    .replace(/Desde este chat no puedo[^.\n]*[.;]\s*/gi, '¡Yo te ayudo dejando todo listo en Misión Control! ')
    .replace(/;?\s*sin evidencia de aceptaci[oó]n(?: en esta lectura)?/gi, '')
    .replace(/;?\s*(?:seguimiento de\s+)?autorizaci[oó]n(?:,\s*ejecuci[oó]n)?\s*y\s*(?:ejecuci[oó]n|evidencia)(?:\s*reportada)?\s*no informadas(?: en esta lectura)?/gi, '')
    .replace(/;?\s*sin ejecutor asignado/gi, ' · sin ejecutor')
    .replace(/,\s*candidato\b/gi, '')
    .replace(/,?\s*nivel de evidencia «?([^»);,]+)»?/gi, ' · evidencia $1')
    .replace(/\s*\(cobertura completa:\s*\d+\s*de\s*\d+\s*proyectos recorridos,\s*\d+\s*registros observados\)/gi, '')
    .replace(/\n+\*\*Resumen acumulado:\*\*[\s\S]*?(?=\n\n¿|$)/gi, '')
    .replace(/\n*\*\((?:Corresponde a las observaciones acumuladas|El registro figura)[^)]*\)\.?\*/gi, '')
    .replace(/\bubicaciones observadas\b/gi, 'piezas')
    .replace(/•\s*\*\*Estado(?: de la ficha)?:\*\*\s*Bloqueado/gi, '🔒 *Estado:* Bloqueado')
    .replace(/•\s*\*\*Estado(?: de la ficha)?:\*\*\s*En verificaci[oó]n/gi, '🟣 *Estado:* Por revisar')
    .replace(/•\s*\*\*Estado(?: de la ficha)?:\*\*\s*(?:En atenci[oó]n|Registrada en atenci[oó]n)/gi, '🟢 *Estado:* En curso')
    .replace(/•\s*\*\*Estado(?: de la ficha)?:\*\*\s*Abierto/gi, '⚪ *Estado:* Abierto')
    .replace(/•\s*\*\*Motivo del bloqueo:\*\*/gi, '⚠️ *Bloqueo:*')
    .replace(/•\s*\*\*Qu[eé] espera:\*\*/gi, '⏳ *Qué falta:*')
    .replace(/•\s*\*\*Situaci[oó]n:\*\*/gi, '📌 *Avance:*')
    .replace(/•\s*\*\*Dependencias registradas:\*\*/gi, '🧩 *Dependencias:*')
    .replace(/•\s*\*\*Ficha:\*\*/gi, '🔗 *Ficha:*')
    .replace(/\*\*Lo recomendado:\*\*\s*\n?/gi, '💡 *Recomendación:* ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\n{3,}/g, '\n\n');

  // If > 980 chars, compact verbose sub-bullets WITHOUT ever cutting off options or recommendations
  if (s.length > 850) {
    s = s.replace(/\n\s+•\s+/g, '\n• ');
    s = s.replace(/```json\n([\s\S]*?)\n```/g, (_, j) => '```json\n' + j.replace(/\n\s+/g, ' ') + '\n```');
    s = s
      .replace(/\s*\(`enc-[^`]+`\s*\/\s*`enc-[^`]+`\)/g, '')
      .replace(/\n\s*•\s*\*\*En qu[eé] consiste:\*\*\s*/gi, '\n   ')
      .replace(/\n\s*•\s*\*\*Ventaja:\*\*\s*/gi, '\n   ✅ ')
      .replace(/\(`enc-[^`]+`\)/g, '')
      .replace(/\n\s*\*Ventaja:\*\s*/gi, '\n   ✅ *Ventaja:* ');
  }
  if (s.length > 980) {
    s = s.replace(/\*\*\n•\s+/g, '** — ').replace(/\n•\s+/g, ' · ');
  }
  if (s.length > 1000) {
    s = s.replace(/\*Ventaja:\*\s*/gi, '').replace(/\s+para habilitar las pruebas conjuntas/gi, '');
  }
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  return s.trim();
}

const DANGLING_END = /\s+(?:y|e|o|u|de|del|en|con|para|por|a|al|el|la|los|las|un|una|su|sus|que|se|primero|previa)$/i;

function stripDangling(str) {
  let out = str.trim();
  while (DANGLING_END.test(out)) {
    const next = out.replace(DANGLING_END, '').trim();
    if (next.length < 4) break;
    out = next;
  }
  return out;
}

function cleanTitle(raw, maxLen = 20, indexNum = null) {
  let rawStr = String(raw || '').replace(/\*+/g, '').replace(/[«»"“”]/g, '').replace(/\s*→.*$/, '').trim();
  // Check if parentheses hold a concrete feature name like (Touch en móvil en Nexus ...)
  const parenFeature = /\((Touch en m[oó]vil[^)]*)\)/i.exec(rawStr);
  if (parenFeature && /frente paralelo/i.test(rawStr)) {
    rawStr = parenFeature[1].replace(/\s+en\s+Nexus.*$/i, '').replace(/`[^`]+`/g, '').trim();
  }
  // Check for "Opción A · ..."
  const optLetter = /^Opci[oó]n\s+([A-Z0-9]+)\s*[·:.\-–—]\s*(.*)$/i.exec(rawStr);
  let prefix = '';
  if (optLetter) {
    prefix = optLetter[1].toUpperCase() + ' · ';
    rawStr = optLetter[2];
  } else if (indexNum) {
    prefix = indexNum + '. ';
  }

  let s = rawStr
    .replace(/^[0-9]+[.)]\s*/, '')
    .replace(/^[•\-–—]\s*/, '')
    .replace(/[:：].*$/, '')
    .replace(/[()]/g, ' ')
    .replace(/`[^`]*`/g, '')
    .replace(/\//g, ' ')
    .replace(/^(?:avanzar con|validar primero|atender un frente paralelo independiente|atender|empezar por|iniciar con|continuar con|ir a|ejecutar|implementar|resolver|priorizar|elegir|enfocarnos en|conectar|conexi[oó]n de|probar de extremo a extremo|probar|verificar|revisar|actualizar|habilitar|corregir|diagnosticar|exportar|definir|confirmar|guardar|revisemos|revisar|veamos|ver|pasar directo a|pasar a|continuar directo con|continuar con|avanzamos con|avanzar con|mostrar|consultar|afinar alg[uú]n|afinar)\s+/i, '')
    .replace(/^(?:el|la|los|las|un|una)\s+/i, '')
    .replace(/\bcontrato de transporte y contexto sellado\b/i, 'Contrato sellado')
    .replace(/\bmigraci[oó]n de ruta en ForgeChat\b/i, 'Migración ruta')
    .replace(/\bmigraci[oó]n de ruta\b/i, 'Migración ruta')
    .replace(/\bcambio directo con respaldo\b/i, 'Cambio directo')
    .replace(/\bvalidaci[oó]n previa en entorno aislado\b/i, 'Prueba aislada')
    .replace(/\s+en\s+(?:ForgeChat|entorno aislado|Nexus|Misi[oó]n Control).*$/i, '')
    .replace(/[:：].*$/, '')
    .replace(/[.,;]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  s = s.replace(/^[0-9]+[.):\-]?\s+/, '');
  s = stripDangling(s);
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);

  const avail = maxLen - prefix.length;
  if (s.length <= avail) return prefix + s;
  const cut = s.slice(0, avail + 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = stripDangling(lastSpace >= 5 ? cut.slice(0, lastSpace) : cut);
  return (prefix + body).slice(0, maxLen).trim();
}

function extractHeaderTitle(text) {
  const firstLine = (text.split(/\r?\n/)[0] || '').replace(/\*+/g, '').trim();
  if (/opciones sobre la mesa|decidir/i.test(firstLine)) return '🧭 Opciones para decidir';
  if (/bloquead|bloqueo/i.test(firstLine)) return '🔒 Bloqueos · Misión Control';
  if (/dependencia/i.test(firstLine)) return '🧩 Dependencias · Alekito';
  if (/touch en m[oó]vil/i.test(firstLine)) return '📱 Touch en móvil · Nexus';
  if (/omnibox/i.test(firstLine)) return '🔎 Omnibox · Misión Control';
  const boldMatch = /\*\*([^*]{3,48})\*\*/.exec(text.split(/\r?\n/)[0] || '');
  if (boldMatch) return ('📋 ' + boldMatch[1].replace(/:$/, '').trim()).slice(0, 60);
  return '🤖 Alekito · Misión Control';
}

function buildInteractiveFromText(rawText) {
  // Burst coalescing in drainOwnerTurnJobs ensures at most 1 card is sent per burst
  if (typeof rawText !== 'string') return null;
  let trimmed = formatExecutiveWhatsApp(rawText);
  if (!trimmed || trimmed.length > 1020) return null;

  const lines = trimmed.split(/\r?\n/);
  const extracted = [];
  const seenTitles = new Set();

  for (const line of lines) {
    const isMetaBullet = /^\s*(?:[•\-–—]|[🔒🟣🟢⚪⚠️⏳📌🧩🔗💡✅])\s+\*+(?:proyecto[^*]*|encargo[^*]*|t[ií]tulo[^*]*|estado[^*]*|seguimiento[^*]*|objetivo[^*]*|criterio[^*]*|alcance[^*]*|resumen[^*]*|ficha[^*]*|motivo[^*]*|bloqueo[^*]*|qu[eé] falta[^*]*|avance[^*]*|dependencias[^*]*|entregable[^*]*|evidencias[^*]*|coincidencias[^*]*|cobertura[^*]*|identidades[^*]*|ubicaciones[^*]*|conflictos[^*]*|total[^*]*|en qu[eé] consiste[^*]*|ventaja[^*]*|recomendaci[oó]n[^*]*|lo recomendado[^*]*|puntos clave[^*]*|resoluci[oó]n[^*]*|idempotencia[^*]*|reversi[oó]n[^*]*|abiertas?|en atenci[oó]n|en curso|en verificaci[oó]n|bloquead[oa]s?|por revisar|hech[oa]s?|duplicad[oa]s?|descartad[oa]s?):?\*+/i.test(line);
    if (isMetaBullet) continue;
    const m = /^\s*(?:([1-9])[.)]|[•\-–—])\s+\*\*([^*]{2,180}?):?\*\*(?:[:：]\s*(.*)|\s+(.*))?$/.exec(line)
           || /^\s*([1-9])[.)]\s+([^:：\n]{2,180})(?:[:：]\s*(.*))?$/.exec(line);
    if (!m) continue;
    const num = /^[1-9]$/.test(m[1] || '') ? m[1] : null;
    const rawHead = m[2] || m[1];
    const rawDesc = (m[3] || m[4] || '').replace(/\*+/g, '').trim();
    const title = cleanTitle(rawHead, 20, num);
    const listTitle = cleanTitle(rawHead, 24, num);
    if (!title || title.length < 3) continue;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    extracted.push({
      id: `opt_${extracted.length + 1}`,
      title,
      listTitle: listTitle || title,
      description: rawDesc ? rawDesc.slice(0, 72) : ''
    });
  }

  const headerText = extractHeaderTitle(trimmed);

  if (extracted.length >= 2 && extracted.length <= 3) {
    return {
      formattedText: trimmed,
      interactive: {
        type: 'button',
        header: { type: 'text', text: headerText },
        body: { text: trimmed },
        footer: { text: 'Toca una opción para elegir' },
        action: {
          buttons: extracted.map(o => ({
            type: 'reply',
            reply: { id: o.id, title: o.title }
          }))
        }
      },
      options: extracted.map(o => ({ id: o.id, title: o.title }))
    };
  }

  if (extracted.length >= 4 && extracted.length <= 10) {
    return {
      formattedText: trimmed,
      interactive: {
        type: 'list',
        header: { type: 'text', text: headerText },
        body: { text: trimmed },
        footer: { text: 'Abre el menú para elegir una opción' },
        action: {
          button: 'Elegir opción',
          sections: [{
            title: 'Opciones disponibles',
            rows: extracted.map(o => ({
              id: o.id,
              title: o.listTitle,
              ...(o.description ? { description: o.description } : {})
            }))
          }]
        }
      },
      options: extracted.map(o => ({ id: o.id, title: o.listTitle }))
    };
  }

  const lastLine = lines[lines.length - 1] || '';
  const abMatch = /¿(?:quieres que|deseas que|prefieres que|quieres|deseas|revisamos|avanzamos|continuamos|vemos)\s+([^?]+?)\s*,?\s+o\s+(?:prefieres\s+(?:que\s+)?|mejor\s+)?([^?]+?)\??\s*$/i.exec(lastLine);
  if (abMatch) {
    const tA = cleanTitle(abMatch[1].replace(/\bpara la llamada\b/gi, '').replace(/\bde estos\b/gi, ''), 20);
    const tB = cleanTitle(abMatch[2].replace(/\ben ForgeChat\b/gi, '').replace(/\bdel nodo\b/gi, 'nodo'), 20);
    if (tA && tB && tA.toLowerCase() !== tB.toLowerCase()) {
      const abOpts = [
        { id: 'opt_1', title: tA },
        { id: 'opt_2', title: tB }
      ];
      return {
        formattedText: trimmed,
        interactive: {
          type: 'button',
          header: { type: 'text', text: headerText },
          body: { text: trimmed },
          footer: { text: 'Elige por dónde continuar' },
          action: { buttons: abOpts.map(o => ({ type: 'reply', reply: { id: o.id, title: o.title } })) }
        },
        options: abOpts
      };
    }
  }
  if (/abiertas[\s\S]*bloqueadas/i.test(lastLine)) {
    const opts = [
      { id: 'opt_1', title: 'Abiertas y en curso' },
      { id: 'opt_2', title: 'Piezas bloqueadas' },
      { id: 'opt_3', title: 'Ver pendientes' }
    ];
    return {
      formattedText: trimmed,
      interactive: {
        type: 'button',
        header: { type: 'text', text: headerText },
        body: { text: trimmed },
        footer: { text: 'Selecciona qué grupo consultar' },
        action: { buttons: opts.map(o => ({ type: 'reply', reply: { id: o.id, title: o.title } })) }
      },
      options: opts
    };
  }
  if (/¿(?:quieres|deseas|te gustaría|continuamos|seguimos|revisamos|te comparto|dejamos|agregamos|guardamos|actualizamos)\b/i.test(lastLine) && !/¿con cuál|¿cuál|¿qué\b|\bo\b|prefieres|alguna indicaci[oó]n|registrar|registremos/i.test(lastLine)) {
    const yn = [
      { id: 'opt_1', title: 'Ver detalle' },
      { id: 'opt_2', title: 'Ver pendientes' }
    ];
    return {
      formattedText: trimmed,
      interactive: {
        type: 'button',
        header: { type: 'text', text: headerText },
        body: { text: trimmed },
        footer: { text: 'Selecciona una acción rápida' },
        action: {
          buttons: yn.map(o => ({ type: 'reply', reply: { id: o.id, title: o.title } }))
        }
      },
      options: yn
    };
  }

  return null;
}

function stripTrailingOwnerQuestions(text) {
  let s = formatExecutiveWhatsApp(text);
  // Strip trailing "What should we do next?" blocks on owner replies so Alek is never nagged with questions
  s = s.replace(/\n+¿(?:Con qué|Con cuál|Quieres que|Deseas que|Te gustaría|Pasamos a|Revisamos|Avanzamos)[^?]*\?(?:\s*\n+[1-3]\.\s+[^\n]+)*\s*$/i, '').trim();
  s = s.replace(/\n+¿[^?\n]+\?\s*$/i, '').trim();
  return s;
}

function createConversationDelivery({pool,load,loadJob,ledger,transactionLedger,insertPendingRow,enqueueSend}={}){
  function jobFor(ctx){
    const rawText = ctx.row.response_json.reply.text;
    const cleanBody = stripTrailingOwnerQuestions(rawText);
    const spec = null;
    if (spec) {
      return {
        kind: 'interactive',
        alekitoConversationRequestId: ctx.scope.request_id,
        accountId: ctx.binding.account.id,
        to: ctx.binding.owner,
        localMessageId: ctx.correlation,
        payload: { interactive: spec.interactive, contextMessageId: ctx.origin.message_id }
      };
    }
    return {
      kind: 'text',
      alekitoConversationRequestId: ctx.scope.request_id,
      accountId: ctx.binding.account.id,
      to: ctx.binding.owner,
      localMessageId: ctx.correlation,
      payload: { body: cleanBody, previewUrl: false, contextMessageId: ctx.origin.message_id }
    };
  }
  async function validate(job){const ctx=await loadJob(job.alekitoConversationRequestId);
    if(ctx.row.correlation_id!==ctx.correlation||!['claimed','queued','uncertain'].includes(ctx.row.delivery_state))P.fail('CONVERSATION_DELIVERY_NOT_CLAIMED',403);
    if(P.stable(job)!==P.stable(jobFor(ctx)))P.fail('CONVERSATION_JOB_BINDING_INVALID',403);return true;}
  async function send(proof){
    const ctx=await load(proof);const claim=await ledger.claimDelivery(ctx.scope);
    if(!claim.claimed)return {replay:true,row:claim.row};
    let tx;
    try{
      const rawText = ctx.row.response_json.reply.text;
      const cleanBody = stripTrailingOwnerQuestions(rawText);
      const spec = null;
      tx=await pool.connect();await tx.query('BEGIN');
      const correlation=await insertPendingRow({account:ctx.binding.account,toNumber:ctx.binding.owner,
        messageType:spec?'interactive':'text',messageBody:cleanBody,contextMessageId:ctx.origin.message_id,
        correlationId:ctx.correlation,templateMeta:{origin:'alekito-conversation-v1',request_id:ctx.scope.request_id,
          ia360_handler_for:ctx.origin.message_id,ingress_ref:proof.ingress_ref,content_digest:ctx.scope.digest,
          ...(spec?{interactive_type:spec.interactive.type,options:spec.options}:{})},db:tx});
      if(correlation!==ctx.correlation)P.fail('OUTBOUND_CORRELATION_CONFLICT',409);
      await transactionLedger(tx).attachDelivery(ctx.scope,claim.token,correlation);
      await tx.query('COMMIT');tx.release();tx=null;
      await load(proof);
      await enqueueSend(jobFor(ctx));
      return {replay:false,row:await ledger.recordDelivery(ctx.scope,claim.token,{state:'queued',correlation_id:ctx.correlation})};
    }catch{
      if(tx){await tx.query('ROLLBACK').catch(()=>{});tx.release();}
      return {replay:false,row:await ledger.recordDelivery(ctx.scope,claim.token,{state:'uncertain'})};
    }
  }
  return Object.freeze({send,validate,buildInteractiveFromText,formatExecutiveWhatsApp});
}
module.exports={createConversationDelivery,buildInteractiveFromText,formatExecutiveWhatsApp};
