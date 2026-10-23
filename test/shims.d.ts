// Tipos mínimos para los tests: el proyecto no instala @types/node.
declare module "*?raw" { const s: string; export default s; }
declare module "node:sqlite" {
  interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
