// A minimal D1Database stand-in over Node's built-in node:sqlite, for tests only.
// Supports prepare().bind().first()/run()/all() and exec(). `failWhen` lets a test make
// chosen statements throw, to exercise D1 failure paths.

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export interface TestD1 {
  db: D1Database;
  sqlite: SqliteDatabase;
  /** Return an Error to make a statement throw (checked before it runs). */
  failWhen: ((sql: string, params: unknown[]) => Error | null) | null;
  /** Make a statement commit and THEN throw (a "lost" success). */
  failAfterWhen: ((sql: string, params: unknown[]) => Error | null) | null;
}

export async function createTestD1(...migrationPaths: string[]): Promise<TestD1> {
  const { DatabaseSync } = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const { readFileSync } = (await import('node:fs' as string)) as {
    readFileSync: (p: string, enc: 'utf8') => string;
  };
  const sqlite = new DatabaseSync(':memory:');
  for (const p of migrationPaths) sqlite.exec(readFileSync(p, 'utf8')); // relative to the project root (vitest cwd)

  const state: TestD1 = { db: null as unknown as D1Database, sqlite, failWhen: null, failAfterWhen: null };
  const norm = (params: unknown[]) => params.map((v) => (v === undefined ? null : v));
  const plain = (row: Record<string, unknown> | undefined) => (row ? { ...row } : null);

  class Stmt {
    constructor(
      private readonly sql: string,
      private readonly params: unknown[] = [],
    ) {}
    bind(...params: unknown[]) {
      return new Stmt(this.sql, norm(params));
    }
    private check() {
      const err = state.failWhen?.(this.sql, this.params);
      if (err) throw err;
    }
    async first<T>(col?: string): Promise<T | null> {
      this.check();
      const row = plain(sqlite.prepare(this.sql).get(...this.params));
      if (!row) return null;
      return (col ? row[col] : row) as T;
    }
    async run() {
      this.check();
      const r = sqlite.prepare(this.sql).run(...this.params);
      const after = state.failAfterWhen?.(this.sql, this.params);
      if (after) throw after;
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async all<T>() {
      this.check();
      const rows = sqlite.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
      return { success: true, results: rows as T[], meta: { changes: 0 } };
    }
  }

  state.db = {
    prepare: (sql: string) => new Stmt(sql),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database;
  return state;
}
