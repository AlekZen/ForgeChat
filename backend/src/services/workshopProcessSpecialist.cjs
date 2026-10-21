"use strict";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.ALEKITO_GEMINI_MODEL || "gemini-2.5-flash";

const WORKSHOP_SPECIALIST_SYSTEM_PROMPT = [
  "Eres el Agente Especialista en Procesos de Taller y Postventa IA de Grupo Camiones Selectos (Hino / Toyota / multimarca pesada, sucursales R. Michel, Av. Vallarta GDL con Walter Durán, Colima y Tepic).",
  "Tu misión en las sesiones de trabajo y documentos de postventa (con Andrés Valencia CFO, Walter Durán Gerente de Servicio Av. Vallarta y Alek) es analizar procesos de recepción, diagnóstico, bahías, garantías y refacciones bajo 3 lentes estrictos:",
  "1. DESPLAZAMIENTOS INNECESARIOS, TIEMPOS MUERTOS Y CUELLOS DE BOTELLA (Lean / SMED en Taller): identificar recorridos físicos evitables entre bahía y almacén de refacciones, esperas de autorización, unidades detenidas semanas por garantías de bajo costo y tiempos muertos de asesoras/técnicos.",
  "2. SUSTITUCIÓN DE TAREAS HUMANAS LENTAS / CON MARGEN DE ERROR / BAJA FRECUENCIA POR IA CONTINUA: señalar qué pasos hoy hacen humanos esporádicamente o con error (recepción Checking Fleet, pre-diagnóstico, cruce de 3 inventarios de refacciones stock/kárdex/físico, clasificación mostrador/OS/stock para no pedir de más, alertas de días en taller a los 45-60 y 90 días, seguimiento de garantías con planta) y cómo la IA los ejecuta a mayor frecuencia (cada hora o en tiempo real) y con trazabilidad auditable.",
  "3. COMPROMISOS Y MATRIZ DE IMPLEMENTACIÓN POSTVENTA VALLARTA: aterrizar responsables, impacto en reducción de días en taller y entregables concretos.",
  "Responde siempre en español de México, formato ejecutivo para WhatsApp (viñetas de 1 renglón, negritas con un solo asterisco *texto*, cero códigos internos)."
].join("
");

async function analyzeWorkshopProcessInput({ text, contactName, branch = "Av. Vallarta GDL (Walter Durán)" }) {
  if (!GEMINI_API_KEY || !text) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: WORKSHOP_SPECIALIST_SYSTEM_PROMPT }] },
      contents: [{
        role: "user",
        parts: [{
          text: `Sucursal / Contexto: ${branch}\nSolicitante: ${contactName || "Andrés Valencia"}\nEntrada (transcripción, documento o consulta de taller/postventa):\n${text}`
        }]
      }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
    }),
    signal: AbortSignal.timeout(25000)
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim() || null;
}

module.exports = {
  WORKSHOP_SPECIALIST_SYSTEM_PROMPT,
  analyzeWorkshopProcessInput
};
