import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config";

/** Minimal query surface shared by the pool and transaction clients. */
export interface Db {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<R extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}
export type Tx = PoolClient;

const globalForPool = globalThis as unknown as { __wbPool?: Pool; __wbPoolUrl?: string };

export function pool(): Pool {
  const url = config.databaseUrl;
  if (!globalForPool.__wbPool || globalForPool.__wbPoolUrl !== url) {
    globalForPool.__wbPool = new Pool({ connectionString: url, max: 10 });
    globalForPool.__wbPoolUrl = url;
    // Ensure every session uses UTC.
    globalForPool.__wbPool.on("connect", (c) => {
      void c.query("SET TIME ZONE 'UTC'");
    });
  }
  return globalForPool.__wbPool;
}

export async function closePool() {
  if (globalForPool.__wbPool) {
    await globalForPool.__wbPool.end();
    globalForPool.__wbPool = undefined;
  }
}

export const db: Db = {
  query: (text, params) => pool().query(text, params as unknown[]) as never,
};

/**
 * Run `fn` inside a transaction. Serialization / deadlock failures are retried a few times.
 */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = (err as { code?: string }).code;
      if ((code === "40001" || code === "40P01") && attempt < 4) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function one<R extends QueryResultRow>(q: Db, text: string, params?: unknown[]): Promise<R> {
  const r = await q.query<R>(text, params);
  if (r.rows.length !== 1) throw new Error(`Expected one row, got ${r.rows.length}`);
  return r.rows[0];
}
export async function maybeOne<R extends QueryResultRow>(q: Db, text: string, params?: unknown[]): Promise<R | null> {
  const r = await q.query<R>(text, params);
  return r.rows[0] ?? null;
}
