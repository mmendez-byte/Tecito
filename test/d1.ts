import { DatabaseSync } from "node:sqlite";
import migracion from "../migrations/0001_conversaciones.sql?raw";

/** D1 en memoria sobre node:sqlite, con la migración real aplicada. Alcanza para lo que usa el Worker. */
export function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(migracion);
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        if (p.some((v) => v === undefined)) throw new Error("D1_TYPE_ERROR: undefined no se puede bindear");
        params = p;
        return stmt;
      },
      async run() {
        const r = db.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
      async all() {
        return { success: true, results: db.prepare(sql).all(...params), meta: {} };
      },
      async first(col?: string) {
        const r = db.prepare(sql).get(...params);
        return r ? (col ? r[col] : r) : null;
      },
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}
