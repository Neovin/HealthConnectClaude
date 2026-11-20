import { DurableObject } from "cloudflare:workers";

/** Un record proveniente da Health Connect, normalizzato dall'app Android. */
export interface IncomingRecord {
  id: string; // id univoco (metadata.id di Health Connect, o "daily:YYYY-MM-DD")
  type: string; // es. "ExerciseSession", "SleepSession", "Weight", "DailySummary"
  start: string; // ISO-8601
  end?: string | null; // ISO-8601 (solo per record a intervallo)
  date: string; // giorno locale YYYY-MM-DD (fuso orario del telefono)
  source?: string | null; // pacchetto dell'app di origine
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

export interface QueryOptions {
  type?: string;
  from?: string; // YYYY-MM-DD incluso
  to?: string; // YYYY-MM-DD incluso
  limit?: number;
  order?: "asc" | "desc";
}

export interface StoredRecord {
  id: string;
  type: string;
  start: string;
  end: string | null;
  date: string;
  source: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

const MAX_LIMIT = 2000;

/** Ruta GPS de una actividad (Strava, la app Entreno…), enlazada a su ExerciseSession por la hora. */
export interface IncomingRoute {
  id: string; // p. ej. "strava:21059684346" o "entreno:<uuid>"
  start: string; // ISO-8601 UTC
  end: string; // ISO-8601 UTC
  date: string; // día local YYYY-MM-DD
  activity?: string | null; // "biking", "walking"…
  source?: string | null; // "strava", "entreno"…
  name?: string | null;
  session_id?: string | null; // id de la ExerciseSession de Health Connect, si ya se conoce
  distance_m?: number | null;
  elevation_gain_m?: number | null;
  points: number[][]; // [segundos desde el inicio, lat, lon, altitud?]
}

export interface RouteSummary {
  id: string;
  session_id: string | null;
  start: string;
  end: string;
  date: string;
  activity: string | null;
  source: string | null;
  name: string | null;
  distance_m: number;
  elevation_gain_m: number;
  n_points: number;
}

/** Distancia (m) y desnivel positivo (m) de una lista de puntos. */
export function medirRuta(points: number[][]): { distance_m: number; elevation_gain_m: number } {
  let d = 0;
  let sube = 0;
  const R = 6371000;
  const rad = Math.PI / 180;
  for (let i = 1; i < points.length; i++) {
    const [, la1, lo1, a1] = points[i - 1];
    const [, la2, lo2, a2] = points[i];
    const x = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((lo2 - lo1) * rad) / 2) ** 2;
    d += 2 * R * Math.asin(Math.sqrt(x));
    if (a1 != null && a2 != null && a2 > a1) sube += a2 - a1;
  }
  return { distance_m: Math.round(d), elevation_gain_m: Math.round(sube) };
}

/**
 * Durable Object con storage SQLite: contiene tutti i dati sanitari.
 * Esiste una sola istanza (nome "main").
 */
export class HealthStore extends DurableObject {
  private sql: SqlStorage;

  private statsReady = false;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    try {
      this.ensureSchema();
    } catch (e) {
      // Se il limite giornaliero di scritture è esaurito, creare tabelle o il riepilogo fallisce:
      // la lettura deve continuare a funzionare, quindi si riprova alla prossima occasione.
      console.warn("ensureSchema rimandato:", e);
    }
  }

  /**
   * Crea tabelle, indice e riepilogo solo se mancano. Quando è già tutto pronto esegue
   * soltanto letture, così le richieste di sola lettura non scrivono nulla.
   */
  private ensureSchema(): void {
    const existing = new Set(
      this.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index')`)
        .toArray()
        .map((r) => r.name),
    );
    if (!existing.has("routes")) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS routes (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          local_date TEXT NOT NULL,
          activity TEXT,
          source TEXT,
          name TEXT,
          distance_m REAL NOT NULL,
          elevation_gain_m REAL NOT NULL,
          n_points INTEGER NOT NULL,
          points TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_routes_date ON routes(local_date);
      `);
    }
    if (!existing.has("records") || !existing.has("idx_type_date") || !existing.has("meta") || !existing.has("type_stats")) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS records (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT,
          local_date TEXT NOT NULL,
          source TEXT,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_type_date ON records(type, local_date);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS type_stats (
          type TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          first_date TEXT NOT NULL,
          last_date TEXT NOT NULL
        );
      `);
    }
    // Riepilogo per tipo (usato da get_overview): calcolato una sola volta sui dati esistenti,
    // poi aggiornato a ogni sincronizzazione, così la panoramica non rilegge tutto l'archivio.
    this.statsReady = this.sql.exec(`SELECT 1 FROM meta WHERE key = 'type_stats_v1'`).toArray().length > 0;
    if (!this.statsReady) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM type_stats`);
        this.sql.exec(
          `INSERT INTO type_stats (type, count, first_date, last_date)
           SELECT type, COUNT(*), MIN(local_date), MAX(local_date) FROM records GROUP BY type`,
        );
        this.sql.exec(`INSERT INTO meta (key, value) VALUES ('type_stats_v1', '1')`);
      });
      this.statsReady = true;
    }
  }

  async upsert(records: IncomingRecord[], deletedIds: string[] = []): Promise<{ upserted: number; deleted: number }> {
    if (!this.statsReady) this.ensureSchema();
    const now = Date.now();
    let upserted = 0;
    let deleted = 0;
    // Variazioni del riepilogo per tipo in questo invio (scritte una volta sola alla fine).
    const stats = new Map<string, { added: number; first: string; last: string }>();
    const bump = (type: string, date: string, added: number) => {
      const s = stats.get(type);
      if (!s) stats.set(type, { added, first: date, last: date });
      else {
        s.added += added;
        if (date < s.first) s.first = date;
        if (date > s.last) s.last = date;
      }
    };
    this.ctx.storage.transactionSync(() => {
      for (const r of records) {
        const data = JSON.stringify(r.data ?? {});
        const end = r.end ?? null;
        const source = r.source ?? null;
        // Record nuovo: viene inserito. Record già presente: viene riscritto solo se è cambiato,
        // così i record identici reinviati a ogni sincronizzazione non consumano il limite
        // giornaliero di rows_written del piano gratuito.
        const ins = this.sql.exec(
          `INSERT INTO records (id, type, start_time, end_time, local_date, source, data, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
          r.id, r.type, r.start, end, r.date, source, data, now,
        );
        if (ins.rowsWritten > 0) {
          upserted++;
          bump(r.type, r.date, 1);
          continue;
        }
        const upd = this.sql.exec(
          `UPDATE records SET type = ?, start_time = ?, end_time = ?, local_date = ?, source = ?, data = ?, updated_at = ?
           WHERE id = ? AND (data IS NOT ? OR type IS NOT ? OR start_time IS NOT ? OR end_time IS NOT ?
                             OR local_date IS NOT ? OR source IS NOT ?)`,
          r.type, r.start, end, r.date, source, data, now,
          r.id, data, r.type, r.start, end, r.date, source,
        );
        if (upd.rowsWritten > 0) {
          upserted++;
          bump(r.type, r.date, 0);
        }
      }
      for (const id of deletedIds) {
        const row = this.sql.exec<{ type: string }>(`SELECT type FROM records WHERE id = ?`, id).toArray()[0];
        if (!row) continue;
        this.sql.exec(`DELETE FROM records WHERE id = ?`, id);
        deleted++;
        this.sql.exec(`UPDATE type_stats SET count = MAX(count - 1, 0) WHERE type = ?`, row.type);
      }
      for (const [type, s] of stats) {
        this.sql.exec(
          `INSERT INTO type_stats (type, count, first_date, last_date) VALUES (?, ?, ?, ?)
           ON CONFLICT(type) DO UPDATE SET
             count = count + excluded.count,
             first_date = MIN(first_date, excluded.first_date),
             last_date = MAX(last_date, excluded.last_date)`,
          type, s.added, s.first, s.last,
        );
      }
      this.sql.exec(
        `INSERT INTO meta (key, value) VALUES ('last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        new Date(now).toISOString(),
      );
    });
    return { upserted, deleted };
  }

  /** Restituisce JSON (StoredRecord[]) per evitare tipi RPC complessi. */
  async query(opts: QueryOptions): Promise<string> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.type) {
      where.push("type = ?");
      args.push(opts.type);
    }
    if (opts.from) {
      where.push("local_date >= ?");
      args.push(opts.from);
    }
    if (opts.to) {
      where.push("local_date <= ?");
      args.push(opts.to);
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 500), MAX_LIMIT);
    const order = opts.order === "desc" ? "DESC" : "ASC";
    const sql = `SELECT id, type, start_time, end_time, local_date, source, data FROM records
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY local_date ${order}, start_time ${order} LIMIT ${limit}`;
    // Ordinare prima per giorno sfrutta l'indice (type, local_date): con LIMIT il server
    // legge solo le righe necessarie invece di tutte quelle del periodo.
    const rows = this.sql
      .exec<{
        id: string;
        type: string;
        start_time: string;
        end_time: string | null;
        local_date: string;
        source: string | null;
        data: string;
      }>(sql, ...args)
      .toArray()
      .map((row) => ({
        id: row.id,
        type: row.type,
        start: row.start_time,
        end: row.end_time,
        date: row.local_date,
        source: row.source,
        data: JSON.parse(row.data) as Record<string, any>,
      }));
    return JSON.stringify(rows);
  }

  /** Busca la ExerciseSession que coincide en hora con la ruta (más de la mitad solapada). */
  private sesionDe(start: string, end: string, date: string): string | null {
    const d = new Date(date + "T12:00:00Z").getTime();
    const dia = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const rows = this.sql
      .exec<{ id: string; start_time: string; end_time: string | null; source: string | null }>(
        `SELECT id, start_time, end_time, source FROM records WHERE type = 'ExerciseSession' AND local_date BETWEEN ? AND ?`,
        dia(d - 86400000), dia(d + 86400000),
      )
      .toArray();
    const a0 = Date.parse(start), a1 = Date.parse(end);
    let mejor: { id: string; sol: number } | null = null;
    for (const r of rows) {
      if (!r.end_time) continue;
      // Las sesiones que Google Fit detecta solo no cuentan: el usuario solo usa las del reloj
      if (r.source === "com.google.android.apps.fitness") continue;
      const b0 = Date.parse(r.start_time), b1 = Date.parse(r.end_time);
      const sol = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
      if (sol >= 0.5 * Math.min(a1 - a0, b1 - b0) && (!mejor || sol > mejor.sol)) mejor = { id: r.id, sol };
    }
    return mejor?.id ?? null;
  }

  async upsertRoutes(routes: IncomingRoute[], deletedIds: string[] = []): Promise<{ upserted: number; deleted: number; linked: number }> {
    if (!this.statsReady) this.ensureSchema();
    const now = Date.now();
    let upserted = 0, deleted = 0, linked = 0;
    this.ctx.storage.transactionSync(() => {
      for (const r of routes) {
        const medida = medirRuta(r.points);
        const sesion = r.session_id ?? this.sesionDe(r.start, r.end, r.date);
        if (sesion) linked++;
        this.sql.exec(
          `INSERT INTO routes (id, session_id, start_time, end_time, local_date, activity, source, name, distance_m, elevation_gain_m, n_points, points, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, start_time = excluded.start_time, end_time = excluded.end_time,
             local_date = excluded.local_date, activity = excluded.activity, source = excluded.source, name = excluded.name,
             distance_m = excluded.distance_m, elevation_gain_m = excluded.elevation_gain_m, n_points = excluded.n_points,
             points = excluded.points, updated_at = excluded.updated_at`,
          r.id, sesion, r.start, r.end, r.date, r.activity ?? null, r.source ?? null, r.name ?? null,
          r.distance_m ?? medida.distance_m, r.elevation_gain_m ?? medida.elevation_gain_m, r.points.length, JSON.stringify(r.points), now,
        );
        upserted++;
      }
      for (const id of deletedIds) deleted += this.sql.exec(`DELETE FROM routes WHERE id = ?`, id).rowsWritten > 0 ? 1 : 0;
    });
    return { upserted, deleted, linked };
  }

  /** Lista de rutas sin los puntos (JSON de RouteSummary[]). */
  async listRoutes(from: string, to: string): Promise<string> {
    if (!this.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = 'routes'`).toArray().length) return "[]";
    const rows = this.sql
      .exec<Record<string, any>>(
        `SELECT id, session_id, start_time, end_time, local_date, activity, source, name, distance_m, elevation_gain_m, n_points
         FROM routes WHERE local_date BETWEEN ? AND ? ORDER BY start_time`,
        from, to,
      )
      .toArray()
      .map((r) => ({
        id: r.id, session_id: r.session_id, start: r.start_time, end: r.end_time, date: r.local_date, activity: r.activity,
        source: r.source, name: r.name, distance_m: r.distance_m, elevation_gain_m: r.elevation_gain_m, n_points: r.n_points,
      }));
    return JSON.stringify(rows);
  }

  /** Una ruta con sus puntos, la sesión enlazada y los registros de pulso de ese intervalo (JSON). */
  async getRoute(id: string): Promise<string> {
    const r = this.sql.exec<Record<string, any>>(`SELECT * FROM routes WHERE id = ?`, id).toArray()[0];
    if (!r) return "null";
    const sesion = r.session_id
      ? this.sql.exec<{ data: string; source: string | null }>(`SELECT data, source FROM records WHERE id = ?`, r.session_id).toArray()[0]
      : undefined;
    const a0 = Date.parse(r.start_time), a1 = Date.parse(r.end_time);
    const hr = this.sql
      .exec<{ start_time: string; end_time: string | null; data: string }>(
        `SELECT start_time, end_time, data FROM records WHERE type = 'HeartRate' AND local_date BETWEEN ? AND ?`,
        new Date(a0 - 86400000).toISOString().slice(0, 10), new Date(a1 + 86400000).toISOString().slice(0, 10),
      )
      .toArray()
      .map((h) => ({ t0: Date.parse(h.start_time), t1: h.end_time ? Date.parse(h.end_time) : Date.parse(h.start_time), ...JSON.parse(h.data) }))
      .filter((h) => h.t1 >= a0 && h.t0 <= a1)
      .map((h) => ({ t: Math.round(((h.t0 + h.t1) / 2 - a0) / 1000), bpm: h.bpm_avg as number }));
    return JSON.stringify({
      id: r.id, session_id: r.session_id, start: r.start_time, end: r.end_time, date: r.local_date, activity: r.activity,
      source: r.source, name: r.name, distance_m: r.distance_m, elevation_gain_m: r.elevation_gain_m,
      session: sesion ? { source: sesion.source, ...JSON.parse(sesion.data) } : null,
      points: JSON.parse(r.points) as number[][],
      heart_rate: hr,
    });
  }

  async overview(): Promise<{
    last_sync: string | null;
    types: { type: string; count: number; first_date: string; last_date: string }[];
  }> {
    const types = this.sql
      .exec<{ type: string; count: number; first_date: string; last_date: string }>(
        this.statsReady
          ? `SELECT type, count, first_date, last_date FROM type_stats WHERE count > 0 ORDER BY type`
          : `SELECT type, COUNT(*) AS count, MIN(local_date) AS first_date, MAX(local_date) AS last_date
             FROM records GROUP BY type ORDER BY type`,
      )
      .toArray();
    const meta = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = 'last_sync'`).toArray();
    if (this.sql.exec(`SELECT 1 FROM sqlite_master WHERE name = 'routes'`).toArray().length) {
      const rt = this.sql
        .exec<{ count: number; first_date: string | null; last_date: string | null }>(
          `SELECT COUNT(*) AS count, MIN(local_date) AS first_date, MAX(local_date) AS last_date FROM routes`,
        )
        .toArray()[0];
      if (rt && rt.count > 0) types.push({ type: "Route (rutas GPS: list_routes / get_route)", count: rt.count, first_date: rt.first_date!, last_date: rt.last_date! });
    }
    return { last_sync: meta[0]?.value ?? null, types };
  }
}
