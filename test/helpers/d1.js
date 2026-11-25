// A stand-in for Cloudflare D1 over an in-memory SQLite database, so the worker
// can be tested against real SQL. It covers the parts of the D1 API that
// src/worker.js uses: prepare, bind, first, all, run and batch.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../migrations/', import.meta.url);

// D1 turns booleans into 0 and 1 and refuses undefined. Whole numbers go in as
// integers, which node:sqlite only does for BigInt.
function toSqlite(value) {
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : value;
  if (value === null || typeof value === 'string') return value;
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}'`);
}

// D1 refuses a statement with the wrong number of bindings. node:sqlite quietly
// uses NULL for the missing ones, which would hide a real mistake.
function countPlaceholders(sql) {
  const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, '');
  return (bare.match(/\?/g) ?? []).length;
}

const plain = (row) => ({ ...row });

class Statement {
  #sqlite;
  #sql;
  #args;

  constructor(sqlite, sql, args = []) {
    this.#sqlite = sqlite;
    this.#sql = sql;
    this.#args = args;
  }

  bind(...args) {
    return new Statement(this.#sqlite, this.#sql, args.map(toSqlite));
  }

  // Runs the statement now. Everything else is a thin async wrapper around this.
  execute() {
    const expected = countPlaceholders(this.#sql);
    if (expected !== this.#args.length) {
      throw new Error(`D1_ERROR: Wrong number of parameter bindings for SQL query (wanted ${expected}, got ${this.#args.length}).`);
    }
    try {
      const statement = this.#sqlite.prepare(this.#sql);
      // Node 22.16 can say whether a statement returns rows. Before that, go by how it starts.
      const returnsRows = typeof statement.columns === 'function' ? statement.columns().length > 0 : /^\s*(SELECT|WITH)\b/i.test(this.#sql);
      if (returnsRows) {
        return { success: true, results: statement.all(...this.#args).map(plain), meta: { changes: 0, last_row_id: 0 } };
      }
      const done = statement.run(...this.#args);
      return { success: true, results: [], meta: { changes: Number(done.changes), last_row_id: Number(done.lastInsertRowid) } };
    } catch (error) {
      throw new Error(`D1_ERROR: ${error.message}`, { cause: error });
    }
  }

  async first(column) {
    const row = this.execute().results[0];
    if (row === undefined) return null;
    return column === undefined ? row : row[column];
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }
}

export class D1Shim {
  #sqlite;

  constructor(sqlite) {
    this.#sqlite = sqlite;
  }

  prepare(sql) {
    return new Statement(this.#sqlite, sql);
  }

  // Like D1, a batch is one transaction: if any statement fails, none of them apply.
  async batch(statements) {
    this.#sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.execute());
      this.#sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.#sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

export const migrationFiles = () => readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();

// Runs the migration files in order. `after` and `upTo` are the four-digit
// numbers at the start of the file names, so { upTo: '0002' } stops before 0003
// and { after: '0002' } carries on from there.
export function applyMigrations(sqlite, { after = '', upTo = '9999' } = {}) {
  for (const name of migrationFiles()) {
    const number = name.slice(0, 4);
    if (number > after && number <= upTo) sqlite.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  }
}

// A new database with the migrations applied. `sqlite` is the DatabaseSync, for
// setting up and inspecting rows directly. `db` is what the worker gets as env.DB.
export function freshDatabase(options) {
  const sqlite = new DatabaseSync(':memory:');
  applyMigrations(sqlite, options);
  return { sqlite, db: new D1Shim(sqlite) };
}

// Synchronous helpers for tests that need to look at or arrange rows directly.
export const rows = (sqlite, sql, ...args) => sqlite.prepare(sql).all(...args).map(plain);
export const row = (sqlite, sql, ...args) => rows(sqlite, sql, ...args)[0] ?? null;
export const exec = (sqlite, sql, ...args) => {
  const done = sqlite.prepare(sql).run(...args);
  return { changes: Number(done.changes), id: Number(done.lastInsertRowid) };
};
