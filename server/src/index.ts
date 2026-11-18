import { handleMcp } from "./mcp";
import { HealthStore, type IncomingRecord } from "./store";

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

function store(env: Env): DurableObjectStub<HealthStore> {
  return env.STORE.get(env.STORE.idFromName("main"));
}

/** Describe un valor recibido sin revelarlo: si es el esperado, otro secreto, o nada (con longitud y tipo de caracteres). */
function describe(v: string, env: Env, expected: "MCP_SECRET" | "MCP_TOKEN"): string {
  if (safeEqual(v, env[expected])) return `${expected} OK`;
  for (const n of ["API_SECRET", "MCP_SECRET", "MCP_TOKEN"] as const) {
    if (safeEqual(v, env[n])) return `INCORRECTO: es tu ${n}`;
  }
  const raro = v.replace(/[A-Za-z0-9]/g, "");
  const ini = v.slice(0, 2);
  const fin = v.slice(-2);
  const espIni = env[expected].slice(0, 2);
  const espFin = env[expected].slice(-2);
  return `INCORRECTO: longitud ${v.length} (esperada ${env[expected].length})` +
    (raro ? `, contiene caracteres no alfanuméricos: ${JSON.stringify([...new Set(raro)].join(""))}` : "") +
    `, empieza ${ini === espIni ? "igual" : "distinto"}, termina ${fin === espFin ? "igual" : "distinto"}`;
}

function decodeSafe(v: string): string {
  try {
    return decodeURIComponent(v).trim();
  } catch {
    return "";
  }
}

/** Endpoint MCP: /mcp/<MCP_SECRET> + cabecera X-API-Key. Hacen falta las dos para leer datos. */
async function route(request: Request, env: Env, path: string): Promise<Response> {
  const m = path.match(/^\/mcp\/([^/]+)$/);
  if (m && safeEqual(decodeSafe(m[1]), env.MCP_SECRET)) {
    // Cabecera X-API-Key (nombre admitido por los conectores de Claude); se acepta también X-MCP-Token.
    const token = (request.headers.get("X-API-Key") ?? request.headers.get("X-MCP-Token") ?? "").trim();
    if (!safeEqual(token, env.MCP_TOKEN)) return new Response("Unauthorized", { status: 401 });
    return handleMcp(request, store(env));
  }
  return new Response("Not Found", { status: 404 });
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

    // Diagnóstico temporal: últimas peticiones recibidas (sin valores de secretos).
    if (path === "/comprobar-peticiones") {
      const list = JSON.parse(await store(env).recentRequests()) as unknown[];
      return new Response(JSON.stringify(list.reverse(), null, 1), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (path !== "/comprobar" && !path.startsWith("/comprobar/") && path !== "/favicon.ico") {
      const copy = request.method === "POST" ? request.clone() : null;
      const res = await route(request, env, path);
      const hdrs = [...request.headers.keys()].filter((k) => !k.startsWith("cf-") && k !== "cookie");
      const apiKey = (request.headers.get("X-API-Key") ?? "").trim();
      let rpc = "";
      if (request.method === "POST") {
        try {
          const body = (await copy!.json()) as { method?: string } | { method?: string }[];
          rpc = Array.isArray(body) ? body.map((m) => m.method).join(",") : body.method ?? "";
        } catch {
          rpc = "(no JSON)";
        }
      }
      await store(env).logRequest(JSON.stringify({
        at: new Date().toISOString(),
        method: request.method,
        ruta: path.startsWith("/mcp/") ? "/mcp/<" + describe(decodeSafe(path.slice(5)), env, "MCP_SECRET") + ">"
          : path.replace(/[A-Za-z0-9%_-]{16,}/g, "<valor oculto>"),
        x_api_key: apiKey ? describe(apiKey, env, "MCP_TOKEN") : "AUSENTE",
        cabeceras: hdrs,
        rpc,
        status: res.status,
        ua: request.headers.get("user-agent") ?? "",
      }));
      return res;
    }

    // Diagnóstico temporal: /comprobar/<valor> dice con qué secreto coincide el valor (sin revelarlos).
    const chk = path.match(/^\/comprobar\/([^/]+)$/);
    if (chk) {
      let v = "";
      try {
        v = decodeURIComponent(chk[1]).trim();
      } catch {
        v = "";
      }
      const hits = (["API_SECRET", "MCP_SECRET", "MCP_TOKEN"] as const).filter((n) => safeEqual(v, env[n]));
      const text = hits.length
        ? `El valor coincide con: ${hits.join(", ")}`
        : `No coincide con ningún secreto. Longitud de tu valor: ${v.length}. ` +
          `Longitudes guardadas: API_SECRET ${env.API_SECRET.length}, MCP_SECRET ${env.MCP_SECRET.length}, MCP_TOKEN ${env.MCP_TOKEN.length}.`;
      return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
