import { detalleRuta, handleMcp } from "./mcp";
import { HealthStore, type IncomingRecord, type IncomingRoute } from "./store";

export { HealthStore };

interface Env {
  STORE: DurableObjectNamespace<HealthStore>;
  /** Clave de ESCRITURA: la usa la app Android para enviar datos (Authorization: Bearer). */
  API_SECRET: string;
  /** Clave de LECTURA: va en la URL del conector de Claude (/mcp/<MCP_SECRET>). */
  MCP_SECRET: string;
  /** Segundo factor de lectura: el conector debe enviar la cabecera X-API-Key con este valor. */
  MCP_TOKEN: string;
}

const MIN_SECRET = 16;

const MAX_RECORDS_PER_REQUEST = 5000;

/** Comparación en tiempo constante para evitar ataques de temporización sobre el secreto. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

function isValidRecord(r: unknown): r is IncomingRecord {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.type === "string" &&
    typeof o.start === "string" &&
    typeof o.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(o.date) &&
    (o.data === undefined || (typeof o.data === "object" && o.data !== null))
  );
}

async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.API_SECRET}`)) return new Response("Unauthorized", { status: 401 });

  let body: { records?: unknown[]; deleted?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON no válido" }, { status: 400 });
  }
  const records = Array.isArray(body.records) ? body.records : [];
  const deleted = Array.isArray(body.deleted) ? body.deleted.filter((d): d is string => typeof d === "string") : [];
  if (records.length > MAX_RECORDS_PER_REQUEST) {
    return Response.json({ error: `Máximo ${MAX_RECORDS_PER_REQUEST} registros por petición` }, { status: 413 });
  }
  const valid = records.filter(isValidRecord);
  const result = await store(env).upsert(valid, deleted);
  return Response.json({ ok: true, ...result, rejected: records.length - valid.length });
}

const MAX_ROUTES_PER_REQUEST = 50;
const MAX_POINTS_PER_ROUTE = 20000;

function isValidRoute(r: unknown): r is IncomingRoute {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === "string" && o.id.length <= 200 &&
    typeof o.start === "string" && !Number.isNaN(Date.parse(o.start)) &&
    typeof o.end === "string" && !Number.isNaN(Date.parse(o.end)) &&
    typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) &&
    Array.isArray(o.points) && o.points.length >= 2 && o.points.length <= MAX_POINTS_PER_ROUTE &&
    o.points.every((p) => Array.isArray(p) && p.length >= 3 && p.length <= 4 && p.every((v) => v === null || typeof v === "number"))
  );
}

/** Rutas GPS (de Strava o grabadas por la app Entreno). Misma clave de escritura que /ingest. */
async function handleRoutes(request: Request, env: Env, id?: string): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.API_SECRET}`)) return new Response("Unauthorized", { status: 401 });
  // Lectura para la app Entreno (misma clave): lista o detalle de una ruta
  if (request.method === "GET") {
    const url = new URL(request.url);
    if (id) {
      const r = JSON.parse(await store(env).getRoute(id));
      if (!r) return Response.json({ error: "No existe" }, { status: 404 });
      const max = Math.min(3000, Math.max(20, Number(url.searchParams.get("max_points")) || 800));
      return Response.json(detalleRuta(r, max, true));
    }
    const from = url.searchParams.get("from") ?? "2000-01-01";
    const to = url.searchParams.get("to") ?? "2999-12-31";
    return new Response(await store(env).listRoutes(from, to), { headers: { "content-type": "application/json" } });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  let body: { routes?: unknown[]; deleted?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON no válido" }, { status: 400 });
  }
  const routes = Array.isArray(body.routes) ? body.routes : [];
  const deleted = Array.isArray(body.deleted) ? body.deleted.filter((d): d is string => typeof d === "string") : [];
  if (routes.length > MAX_ROUTES_PER_REQUEST) {
    return Response.json({ error: `Máximo ${MAX_ROUTES_PER_REQUEST} rutas por petición` }, { status: 413 });
  }
  const valid = routes.filter(isValidRoute);
  const result = await store(env).upsertRoutes(valid, deleted);
  return Response.json({ ok: true, ...result, rejected: routes.length - valid.length });
}

function store(env: Env): DurableObjectStub<HealthStore> {
  return env.STORE.get(env.STORE.idFromName("main"));
}

export default {
  async fetch(request: Request, rawEnv: Env): Promise<Response> {
    // Quita espacios o saltos de línea que se cuelan al pegar los secretos en GitHub.
    const env: Env = {
      ...rawEnv,
      API_SECRET: (rawEnv.API_SECRET ?? "").trim(),
      MCP_SECRET: (rawEnv.MCP_SECRET ?? "").trim(),
      MCP_TOKEN: (rawEnv.MCP_TOKEN ?? "").trim(),
    };
    for (const name of ["API_SECRET", "MCP_SECRET", "MCP_TOKEN"] as const) {
      if (!env[name] || env[name].length < MIN_SECRET) {
        return new Response(`${name} no configurado (mínimo ${MIN_SECRET} caracteres)`, { status: 500 });
      }
    }
    if (env.MCP_SECRET === env.API_SECRET || env.MCP_TOKEN === env.API_SECRET || env.MCP_TOKEN === env.MCP_SECRET) {
      return new Response("API_SECRET, MCP_SECRET y MCP_TOKEN deben ser distintos", { status: 500 });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "" || path === "/") {
      return new Response("Servidor MCP de Health Connect activo.", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (path === "/ingest") return handleIngest(request, env);
    if (path === "/routes") return handleRoutes(request, env);
    const mr = path.match(/^\/routes\/([^/]+)$/);
    if (mr) return handleRoutes(request, env, decodeURIComponent(mr[1]));

    // Endpoint MCP: /mcp/<MCP_SECRET> + cabecera X-API-Key. Hacen falta las dos para leer datos.
    const m = path.match(/^\/mcp\/([^/]+)$/);
    let urlSecret = "";
    try {
      urlSecret = m ? decodeURIComponent(m[1]).trim() : "";
    } catch {
      urlSecret = "";
    }
    if (m && safeEqual(urlSecret, env.MCP_SECRET)) {
      // Cabecera X-API-Key (nombre admitido por los conectores de Claude); se acepta también X-MCP-Token.
      const token = (request.headers.get("X-API-Key") ?? request.headers.get("X-MCP-Token") ?? "").trim();
      if (!safeEqual(token, env.MCP_TOKEN)) return new Response("Unauthorized", { status: 401 });
      return handleMcp(request, store(env));
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
