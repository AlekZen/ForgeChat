import { ContractError, exactObject, opaque, seal } from './conversation-contract.mjs';

// Actual server contracts: app.ts /api/v1/nexus/mcp; mcp.ts estado_nexus and
// contexto_de_contacto; cliente.ts contextoParaCliente. No new auth interface.
const absentReasons = new Set(['no_registrado', 'no_publicado', 'no_interpretable', 'no_autorizado', 'no_aplica']);
// Public server codes only. Never return error.mensaje or arbitrary extra fields.
const remoteCodes = new Set(['entrada_invalida', 'cuenta_no_encontrada', 'cuenta_ambigua',
  'ficha_no_encontrada', 'propuesta_no_encontrada', 'conflicto', 'sin_instantanea',
  'solo_lectura', 'no_autorizado', 'contacto_no_ligado', 'clave_en_conflicto',
  'rfq_no_configurado', 'rfq_retirado', 'rfq_caido', 'rfq_incierto',
  'registro_no_disponible', 'herramienta_desconocida', 'lector_no_configurado',
  'lector_caido', 'catalogo_no_publicado', 'no_configurado', 'interno']);
const scopes = new Set(['lee', 'propone', 'revisa', 'cliente', 'consumo', 'dueno']);
const clientTools = new Set(['contexto_de_contacto', 'pasar_duda']);
const diagnosticCodes = new Set(['MCP_REMOTE_DENIED', 'MCP_INVALID_RESPONSE', 'MCP_IDENTITY_MISMATCH',
  'MCP_SCOPE_DENIED', 'MCP_SCOPE_UNVERIFIED', 'MCP_TIMEOUT', 'MCP_CIRCUIT_OPEN', 'MCP_UNAVAILABLE']);
const stages = new Set(['status', 'identity', 'catalogue', 'context', 'projection', 'circuit']);
const responseSources = new Set(['structuredContent', 'content_json', 'content_error_prefix', 'tools_list']);
export const ADAPTER_CONTRACT_VERSION = 'nexus-client-adapter-v2';

function remoteFailure(code, stage, source) {
  const error = new ContractError('MCP_REMOTE_DENIED');
  error.remoteCode = remoteCodes.has(code) ? code : 'unclassified';
  error.stage = stage;
  error.responseSource = source;
  return error;
}

function publicFailure(error, stage) {
  const fault = error && typeof error === 'object' ? error : {};
  const status = fault.status ?? fault.statusCode ?? fault.response?.status;
  const code = error instanceof ContractError && diagnosticCodes.has(error.code) ? error.code : 'MCP_UNAVAILABLE';
  const remote = code === 'MCP_REMOTE_DENIED';
  return { ok: false, public_code: code,
    stage: stages.has(fault.stage) ? fault.stage : stage,
    error_origin: remote ? 'remote' : error instanceof ContractError && code !== 'MCP_TIMEOUT' ? 'local' : 'transport',
    ...(remote ? { remote_code: remoteCodes.has(fault.remoteCode) ? fault.remoteCode : 'unclassified',
      response_source: responseSources.has(fault.responseSource) ? fault.responseSource : 'structuredContent' } : {}),
    ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { http_status: status } : {}),
    ...(Number.isInteger(fault.code) && fault.code >= -32768 && fault.code <= -32000 ? { rpc_code: fault.code } : {}) };
}
const record = v => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ContractError('MCP_INVALID_RESPONSE');
  return v;
};
const text = v => {
  if (typeof v !== 'string' || v.length > 20_000) throw new ContractError('MCP_INVALID_RESPONSE');
  return v;
};
const number = v => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError('MCP_INVALID_RESPONSE');
  return v;
};
const bool = v => {
  if (typeof v !== 'boolean') throw new ContractError('MCP_INVALID_RESPONSE');
  return v;
};
const nullable = fn => v => v === null ? null : fn(v);
const list = fn => v => {
  if (!Array.isArray(v) || v.length > 500) throw new ContractError('MCP_INVALID_RESPONSE');
  return v.map(fn);
};
const fields = schema => v => {
  record(v);
  return Object.fromEntries(Object.entries(schema).filter(([key]) => Object.hasOwn(v, key))
    .map(([key, fn]) => [key, fn(v[key])]));
};
const absence = fn => v => {
  if (v && typeof v === 'object' && Object.hasOwn(v, 'ausente')) {
    if (!absentReasons.has(v.ausente)) throw new ContractError('MCP_INVALID_RESPONSE');
    return { ausente: v.ausente, detalle: text(v.detalle) };
  }
  return fn(v);
};
const capability = fields({ nombre: nullable(text), resuelve: text, que_te_da: text,
  incluye: absence(list(text)), no_incluye: absence(list(text)), plazo_semanas: number });
const projectProposal = fields({ nombre: text, estado: text, capacidades: list(capability),
  anios: number, escenario: text, forma_de_pago: text, iva: text,
  liga: fields({ url: text, version: number, firmada: bool }), fuente: text });
const proposal = v => {
  if (!['firmada', 'enviada al cliente'].includes(v?.estado)) throw new ContractError('MCP_INVALID_RESPONSE');
  return projectProposal(v);
};
const customerPending = fields({ que: text, para: nullable(text), quien: nullable(text),
  cuando: nullable(text), estado: text, pausa_el_plazo: bool, desde: nullable(text) });
const account = fields({
  cuenta: fields({ nombre: text }),
  persona: fields({ nombre: absence(text), cargo: text, tambien_le_dicen: list(text), fuente: text }),
  propuesta: absence(list(proposal)),
  lo_que_falta_del_cliente: absence(fields({ registros: list(customerPending), fuente: text })),
  ya_hecho: absence(fields({ registros: list(fields({ que: text, desde: nullable(text) })), fuente: text })),
  respuestas_revisadas: absence(list(fields({ tema: text, respuesta: text, cita: text,
    revisada_por: text, en: nullable(text) })))
});

export function projectClientContext(value) {
  record(value);
  bool(value.ligado);
  if (value.ligado && (!Array.isArray(value.cuentas) || !value.cuentas.length)) {
    throw new ContractError('MCP_INVALID_RESPONSE');
  }
  if (!value.ligado && value.cuentas?.length) throw new ContractError('MCP_INVALID_RESPONSE');
  for (const entry of value.cuentas ?? []) {
    record(entry);
    for (const key of ['cuenta', 'persona', 'propuesta', 'lo_que_falta_del_cliente', 'ya_hecho', 'respuestas_revisadas']) {
      if (!Object.hasOwn(entry, key)) throw new ContractError('MCP_INVALID_RESPONSE');
    }
    text(entry.cuenta?.nombre);
  }
  return fields({ ligado: bool, cuentas: list(account), nota: text, publicada_en: text })(value);
}

function payload(result, stage) {
  record(result);
  let data = result.structuredContent;
  let source = 'structuredContent';
  if (data?.error) throw remoteFailure(data.error.codigo, stage, source);
  if (!data) {
    const blocks = result.content?.filter(c => c.type === 'text');
    if (!Array.isArray(blocks) || blocks.length !== 1 || typeof blocks[0].text !== 'string' ||
        blocks[0].text.length > 256_000) throw new ContractError('MCP_INVALID_RESPONSE');
    source = 'content_json';
    try { data = JSON.parse(blocks[0].text); } catch {
      const code = /^Error \[([a-z_]+)\]:/.exec(blocks[0].text.slice(0, 128))?.[1];
      if (result.isError) throw remoteFailure(code, stage, 'content_error_prefix');
      throw new ContractError('MCP_INVALID_RESPONSE');
    }
  }
  record(data);
  if (data.error || result.isError) throw remoteFailure(data.error?.codigo, stage, source);
  return data;
}

function accessMetadata(state) {
  const access = record(state.acceso);
  if (typeof access.agente !== 'string' || !access.agente || access.agente.length > 120 ||
      /[\u0000-\u001f]/.test(access.agente) ||
      !scopes.has(access.alcance) || ['puede_proponer', 'puede_revisar', 'puede_escribir']
        .some(key => typeof access[key] !== 'boolean')) throw new ContractError('MCP_INVALID_RESPONSE');
  return { agente: access.agente, alcance: access.alcance,
    puede_proponer: access.puede_proponer, puede_revisar: access.puede_revisar,
    puede_escribir: access.puede_escribir,
    ambito_tipo: access.ambito === 'todo' ? 'todo' : 'acotado' };
}

export async function inspectNexusBinding({ callTool, timeoutMs = 10_000 } = {}) {
  // Development diagnostic only: reports the authenticated identity as-is.
  // Broad development access is not an error and is never passed to readContext.
  if (typeof callTool !== 'function') throw new ContractError('NOT_BOUND');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw new ContractError('INVALID_TIMEOUT');
  const controller = new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => callTool({ name: 'estado_nexus', arguments: {} }, { signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new ContractError('MCP_TIMEOUT'));
      }, timeoutMs); })
    ]);
    const access = accessMetadata(payload(result, 'status'));
    return { ok: true, access, alekito_context_eligible: access.agente === 'alekito-whatsapp' &&
      access.alcance === 'cliente' && !access.puede_escribir && !access.puede_revisar };
  } catch (error) { return publicFailure(error, 'status'); }
  finally { clearTimeout(timer); }
}

export function createExistingNexusClientAdapter({ client, timeoutMs = 10_000 } = {}) {
  // Both methods must belong to the SAME existing authenticated client. No owner
  // binding is substituted. This module never
  // loads a token, creates a credential, provides auth headers, or changes grants.
  if (typeof client?.callTool !== 'function' || typeof client?.listTools !== 'function') throw new ContractError('NOT_BOUND');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) {
    throw new ContractError('INVALID_TIMEOUT');
  }
  const counters = { listCalls: 0, statusCalls: 0, contextCalls: 0, successes: 0, errors: 0, denied: 0 };
  let consecutiveErrors = 0;
  async function invoke(action) {
    if (consecutiveErrors >= 2) return { ok: false, public_code: 'MCP_CIRCUIT_OPEN', stage: 'circuit', error_origin: 'local' };
    const controller = new AbortController();
    let timer;
    let stage = 'catalogue';
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => action(controller.signal, value => { stage = value; })),
        new Promise((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new ContractError('MCP_TIMEOUT'));
        }, timeoutMs); })
      ]);
      consecutiveErrors = 0;
      counters.successes++;
      return { ok: true, ...result };
    } catch (error) {
      consecutiveErrors++; counters.errors++;
      return publicFailure(error, stage);
    } finally { clearTimeout(timer); }
  }
  async function catalogue(signal) {
    if (signal.aborted) throw new ContractError('MCP_TIMEOUT');
    counters.listCalls++;
    const result = await client.listTools({}, { signal });
    if (signal.aborted) throw new ContractError('MCP_TIMEOUT');
    record(result);
    if (result.error) throw remoteFailure(result.error.codigo, 'catalogue', 'tools_list');
    if (!Array.isArray(result.tools) || result.tools.length > 100) throw new ContractError('MCP_INVALID_RESPONSE');
    if (result.nextCursor) throw new ContractError('MCP_SCOPE_UNVERIFIED');
    const names = result.tools.map(tool => text(record(tool).name));
    if (!names.includes('contexto_de_contacto') || new Set(names).size !== names.length ||
        names.some(name => !clientTools.has(name))) throw new ContractError('MCP_SCOPE_DENIED');
    // tools/list verifies the restricted surface, not a named remote identity.
    // The existing service binding remains selected by the trusted backend.
    return { tools: names, client_surface_verified: true, named_identity_verified: false };
  }
  return Object.freeze({
    counters: () => ({ ...counters, consecutiveErrors }),
    probe: () => invoke(async signal => ({ surface: await catalogue(signal) })),
    async readContext(input) {
      exactObject(input, ['requestId', 'sello']);
      opaque(input.requestId); seal(input.sello);
      return invoke(async (signal, setStage) => {
        await catalogue(signal);
        if (signal.aborted) throw new ContractError('MCP_TIMEOUT');
        counters.contextCalls++;
        setStage('context');
        const context = payload(await client.callTool({ name: 'contexto_de_contacto',
          arguments: { sello: input.sello } }, { signal }), 'context');
        if (signal.aborted) throw new ContractError('MCP_TIMEOUT');
        // Without configured server seal, passing only sello fails closed in
        // deQuienEscribe: no contacto fallback is supplied by this adapter.
        setStage('projection');
        return { context: projectClientContext(context) };
      });
    },
    denyUnsupportedOperation() {
      counters.denied++;
      return { ok: false, public_code: 'MCP_SCOPE_DENIED' };
    }
  });
}
