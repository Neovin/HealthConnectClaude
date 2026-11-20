import type { HealthStore, QueryOptions, StoredRecord } from "./store";

/**
 * Implementación mínima y sin estado del transporte MCP "Streamable HTTP":
 * cada POST contiene uno o varios mensajes JSON-RPC y recibe la respuesta en JSON.
 */

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INSTRUCTIONS = `Este servidor expone los datos de salud y actividad física del usuario, sincronizados desde Android Health Connect.
- Empieza con get_overview para saber qué datos existen y qué intervalo de fechas cubren.
- Para totales diarios (pasos, distancia, calorías, sueño, frecuencia cardíaca, minutos de ejercicio) usa get_daily_summary: los valores ya están deduplicados entre apps.
- Para entrenamientos usa get_workouts, para el sueño get_sleep y para todo lo demás get_records.
- Las rutas GPS (salidas en bici y caminatas largas) están en list_routes y get_route; cada ruta va enlazada a su entrenamiento y get_route incluye el pulso a lo largo del recorrido.
- Las sesiones con source com.google.android.apps.fitness son detecciones automáticas de Google Fit: el usuario no las usa, ignóralas.
- Las fechas son días locales en formato YYYY-MM-DD; las horas de inicio y fin de los registros van en UTC. Distancias en metros, energía en kcal, masas en kg.`;

type Json = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

const dateProp = (desc: string) => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: desc });

const RECORD_TYPES = [
  "DailySummary",
  "ExerciseSession",
  "SleepSession",
  "HeartRate",
  "RestingHeartRate",
  "HeartRateVariabilityRmssd",
  "Weight",
  "Height",
  "BodyFat",
  "LeanBodyMass",
  "BasalMetabolicRate",
  "OxygenSaturation",
  "RespiratoryRate",
  "BloodPressure",
  "BloodGlucose",
  "BodyTemperature",
  "Hydration",
  "Nutrition",
  "Vo2Max",
];

const TOOLS = [
  {
    name: "get_overview",
    title: "Resumen de datos",
    description:
      "Enumera los tipos de datos de salud disponibles, con número de registros, primera y última fecha, y la hora de la última sincronización desde el móvil.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_daily_summary",
    title: "Resumen diario",
    description:
      "Totales por día (deduplicados por Health Connect): pasos, distancia (m), calorías activas y totales (kcal), pisos subidos, desnivel (m), minutos de ejercicio, minutos de sueño, frecuencia cardíaca media/mín/máx, FC en reposo, peso medio, hidratación (L), calorías ingeridas.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: dateProp("Primer día incluido (YYYY-MM-DD)"),
        end_date: dateProp("Último día incluido (YYYY-MM-DD)"),
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
  },
  {
    name: "get_workouts",
    title: "Entrenamientos",
    description:
      "Sesiones de entrenamiento/ejercicio con tipo de actividad, duración y (si están disponibles) distancia, calorías, pasos y frecuencia cardíaca de la sesión.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: dateProp("Primer día incluido (YYYY-MM-DD)"),
        end_date: dateProp("Último día incluido (YYYY-MM-DD)"),
        limit: { type: "integer", minimum: 1, maximum: 2000, description: "Número máximo de resultados (por defecto 200)" },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sleep",
    title: "Sueño",
    description:
      "Sesiones de sueño con hora de inicio/fin, duración y minutos por fase (despierto, ligero, profundo, REM). La fecha es la del día en que te despiertas.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: dateProp("Primer día incluido (YYYY-MM-DD)"),
        end_date: dateProp("Último día incluido (YYYY-MM-DD)"),
        include_stages: { type: "boolean", description: "Incluir la lista detallada de fases (por defecto false)" },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
  },
  {
    name: "get_records",
    title: "Registros por tipo",
    description:
      "Registros brutos de un tipo concreto en un intervalo de fechas. Tipos: " + RECORD_TYPES.join(", ") + ".",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: RECORD_TYPES, description: "Tipo de registro" },
        start_date: dateProp("Primer día incluido (YYYY-MM-DD)"),
        end_date: dateProp("Último día incluido (YYYY-MM-DD)"),
        limit: { type: "integer", minimum: 1, maximum: 2000, description: "Número máximo de resultados (por defecto 500)" },
        newest_first: { type: "boolean", description: "Ordenar del más reciente al más antiguo (por defecto false)" },
      },
      required: ["type", "start_date", "end_date"],
      additionalProperties: false,
    },
  },
  {
    name: "list_routes",
    title: "Rutas GPS",
    description:
      "Rutas GPS guardadas (salidas en bici, caminatas largas): fecha, hora, actividad, origen, distancia (m), desnivel positivo (m), número de puntos y el id de la sesión de entrenamiento enlazada. Usa get_route para el detalle de una.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: dateProp("Primer día incluido (YYYY-MM-DD)"),
        end_date: dateProp("Último día incluido (YYYY-MM-DD)"),
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
  },
  {
    name: "get_route",
    title: "Detalle de una ruta",
    description:
      "Una ruta GPS con su recorrido (puntos con segundos desde el inicio, lat, lon, altitud, km acumulados y pulso cuando lo hay), parciales por kilómetro (tiempo, desnivel, pulso medio) y el resumen del entrenamiento enlazado.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "id de la ruta (de list_routes)" },
        max_points: { type: "integer", minimum: 20, maximum: 3000, description: "Puntos del recorrido a devolver (por defecto 300; se reduce de forma uniforme)" },
        include_points: { type: "boolean", description: "Incluir el recorrido punto a punto (por defecto true). Con false solo resumen y parciales." },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

const R_TIERRA = 6371000;
function metros(a: number[], b: number[]): number {
  const r = Math.PI / 180;
  const x = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[2] - a[2]) * r) / 2) ** 2;
  return 2 * R_TIERRA * Math.asin(Math.sqrt(x));
}

/** Prepara una ruta para Claude: km acumulados, pulso por punto, parciales por km y recorrido reducido. */
function detalleRuta(r: any, maxPoints: number, conPuntos: boolean): Json {
  const pts: number[][] = r.points;
  const hr: { t: number; bpm: number }[] = (r.heart_rate ?? []).sort((a: any, b: any) => a.t - b.t);
  const pulsoEn = (t: number): number | undefined => {
    if (!hr.length) return undefined;
    let lo = 0, hi = hr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (hr[m].t < t) lo = m + 1; else hi = m; }
    const c = [hr[lo], hr[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    return Math.abs(c.t - t) <= 180 ? Math.round(c.bpm) : undefined;
  };
  let acum = 0;
  const filas = pts.map((p, i) => {
    if (i > 0) acum += metros(pts[i - 1], p);
    return { t: p[0], lat: p[1], lon: p[2], alt: p[3] ?? undefined, km: Math.round(acum) / 1000, hr: pulsoEn(p[0]) };
  });
  // parciales por kilómetro
  const parciales: Json[] = [];
  let ini = 0;
  for (let i = 1; i < filas.length; i++) {
    if (Math.floor(filas[i].km) > Math.floor(filas[ini].km) || i === filas.length - 1) {
      const tramo = filas.slice(ini, i + 1);
      let sube = 0, baja = 0;
      for (let k = 1; k < tramo.length; k++) {
        const d = (tramo[k].alt ?? 0) - (tramo[k - 1].alt ?? 0);
        if (tramo[k].alt != null && tramo[k - 1].alt != null) { if (d > 0) sube += d; else baja -= d; }
      }
      const hrs = tramo.map((f) => f.hr).filter((v): v is number => v != null);
      parciales.push({
        km: parciales.length + 1, segundos: filas[i].t - filas[ini].t,
        sube_m: Math.round(sube), baja_m: Math.round(baja),
        hr_media: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : undefined,
      });
      ini = i;
    }
  }
  const paso = Math.max(1, Math.ceil(filas.length / maxPoints));
  const reducido = filas.filter((_, i) => i % paso === 0 || i === filas.length - 1);
  return {
    id: r.id, date: r.date, start: r.start, end: r.end, activity: r.activity, source: r.source, name: r.name ?? undefined,
    distance_m: r.distance_m, elevation_gain_m: r.elevation_gain_m, duration_s: pts.length ? pts[pts.length - 1][0] - pts[0][0] : 0,
    session: r.session ?? undefined, heart_rate_samples: hr.length,
    splits_km: parciales,
    points: conPuntos ? reducido : undefined,
    points_note: conPuntos ? `${reducido.length} de ${filas.length} puntos; t = segundos desde el inicio` : undefined,
  };
}

class ToolError extends Error {}

function str(args: Json, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`Falta el parámetro: ${key}`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`El parámetro ${key} debe ser una cadena`);
  return v;
}

function dateArg(args: Json, key: string): string {
  const v = str(args, key)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ToolError(`${key} debe tener el formato YYYY-MM-DD`);
  return v;
}

function num(args: Json, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError(`El parámetro ${key} debe ser un número`);
  return n;
}

function compact(r: StoredRecord, extra: Json = {}): Json {
  return { date: r.date, start: r.start, end: r.end ?? undefined, source: r.source ?? undefined, ...r.data, ...extra };
}

async function query(store: DurableObjectStub<HealthStore>, opts: QueryOptions): Promise<StoredRecord[]> {
  return JSON.parse(await store.query(opts)) as StoredRecord[];
}

async function callTool(store: DurableObjectStub<HealthStore>, name: string, args: Json): Promise<unknown> {
  switch (name) {
    case "get_overview":
      return store.overview();

    case "get_daily_summary": {
      const from = dateArg(args, "start_date");
      const to = dateArg(args, "end_date");
      const rows = await query(store, { type: "DailySummary", from, to, limit: 2000 });
      return { days: rows.map((r) => ({ date: r.date, ...r.data })) };
    }

    case "get_workouts": {
      const from = dateArg(args, "start_date");
      const to = dateArg(args, "end_date");
      const rows = await query(store, { type: "ExerciseSession", from, to, limit: num(args, "limit") ?? 200 });
      return { workouts: rows.map((r) => compact(r)) };
    }

    case "get_sleep": {
      const from = dateArg(args, "start_date");
      const to = dateArg(args, "end_date");
      const includeStages = args["include_stages"] === true;
      const rows = await query(store, { type: "SleepSession", from, to, limit: 2000 });
      return {
        sleep: rows.map((r) => {
          const out = compact(r);
          if (!includeStages) delete out["stages"];
          return out;
        }),
      };
    }

    case "get_records": {
      const type = str(args, "type")!;
      const from = dateArg(args, "start_date");
      const to = dateArg(args, "end_date");
      const rows = await query(store, {
        type,
        from,
        to,
        limit: num(args, "limit") ?? 500,
        order: args["newest_first"] === true ? "desc" : "asc",
      });
      return { type, count: rows.length, records: rows.map((r) => compact(r)) };
    }

    case "list_routes": {
      const from = dateArg(args, "start_date");
      const to = dateArg(args, "end_date");
      return { routes: JSON.parse(await store.listRoutes(from, to)) };
    }

    case "get_route": {
      const id = str(args, "id")!;
      const r = JSON.parse(await store.getRoute(id));
      if (!r) throw new ToolError(`No existe la ruta ${id}`);
      return detalleRuta(r, Math.min(3000, Math.max(20, num(args, "max_points") ?? 300)), args["include_points"] !== false);
    }

    default:
      throw new ToolError(`Herramienta desconocida: ${name}`);
  }
}

async function handleMessage(
  msg: JsonRpcRequest,
  store: DurableObjectStub<HealthStore>,
): Promise<Json | null> {
  const isNotification = msg.id === undefined;
  const reply = (result: unknown): Json => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string): Json => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

  if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(-32600, "Invalid Request");
  }
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.["protocolVersion"];
      const protocolVersion =
        typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "health-connect-mcp", title: "Health Connect", version: "1.0.0" },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.["name"];
      const args = (msg.params?.["arguments"] ?? {}) as Json;
      if (typeof name !== "string") return fail(-32602, "Missing tool name");
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(store, name, args);
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return reply({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, store: DurableObjectStub<HealthStore>): Promise<Response> {
  if (request.method !== "POST") {
    // Sin stream SSE desde el servidor: el cliente solo usará POST.
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = (await Promise.all(messages.map((m) => handleMessage(m as JsonRpcRequest, store)))).filter(
    (r): r is Json => r !== null,
  );

  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
