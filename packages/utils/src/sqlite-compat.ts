/**
 * `bun:sqlite` replacement backed by Node's built-in `node:sqlite`.
 *
 * The surface mirrors Bun's `Database` / `Statement` classes — `query`, `prepare`,
 * `run`/`get`/`all`/`values`/`iterate`, `exec`, `transaction`, `serialize`,
 * `deserialize`, `inTransaction` — so call sites keep their shape while the
 * storage engine is Node's synchronous SQLite binding.
 */
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as NodeDatabaseSync, StatementSync } from "node:sqlite";

/**
 * Constructors are loaded on first use. Bun's `--compile` output cannot resolve
 * `node:sqlite` at runtime (Bun 1.3 only exposes it from its own runtime), and a
 * static import makes every bundle that transitively re-exports this module
 * fail to start even when no caller opens a database. A dynamic `require`
 * keeps the dependency out of the compiled module graph.
 */
let databaseSyncConstructor: typeof NodeDatabaseSync | undefined;
function nodeDatabaseSync(): typeof NodeDatabaseSync {
	if (!databaseSyncConstructor) {
		const specifier = "node:sqlite";
		databaseSyncConstructor = (createRequire(import.meta.url)(specifier) as typeof import("node:sqlite"))
			.DatabaseSync as typeof NodeDatabaseSync;
	}
	return databaseSyncConstructor;
}

/** Values accepted as statement bindings, matching Bun's `SQLQueryBindings`. */
export type SQLQueryBindings =
	| string
	| number
	| bigint
	| boolean
	| null
	| undefined
	| Uint8Array
	| Date
	| Record<string, string | number | bigint | boolean | null | undefined | Uint8Array | Date>;

export interface DatabaseOptions {
	readonly?: boolean;
	/** Bun-compatible inverse of `readonly`; `readonly` wins when both are set. */
	readwrite?: boolean;
	create?: boolean;
	strict?: boolean;
	safeIntegers?: boolean;
	timeout?: number;
}

export interface RunResult {
	changes: number;
	lastInsertRowid: number;
}

const TRANSACTION_DEPTH = Symbol("omp.sqlite.transactionDepth");

/**
 * Count bind-parameter slots in `sql`, matching `bun:sqlite`'s `paramsCount`.
 *
 * SQLite numbers parameters in first-appearance order: a bare `?` takes the
 * next slot, `?NNN` claims slot NNN, and a named parameter keeps the slot of
 * its first identical spelling. Quoted strings, quoted identifiers, and
 * comments never introduce parameters.
 */
function countParameters(sql: string): number {
	let maxIndex = 0;
	const namedIndices = new Map<string, number>();
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === "`") {
			i++;
			while (i < sql.length) {
				if (sql[i] !== ch) {
					i++;
					continue;
				}
				if (sql[i + 1] === ch) {
					i += 2;
					continue;
				}
				i++;
				break;
			}
			continue;
		}
		if (ch === "[") {
			while (i < sql.length && sql[i] !== "]") i++;
			i++;
			continue;
		}
		if (ch === "-" && sql[i + 1] === "-") {
			while (i < sql.length && sql[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && sql[i + 1] === "*") {
			i += 2;
			while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (ch === "?") {
			const start = ++i;
			while (i < sql.length && sql[i]! >= "0" && sql[i]! <= "9") i++;
			const explicitIndex = i > start ? Number(sql.slice(start, i)) : 0;
			maxIndex = Math.max(maxIndex, explicitIndex || maxIndex + 1);
			continue;
		}
		if (ch === ":" || ch === "@" || ch === "$") {
			const start = i++;
			while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
			if (i > start + 1) {
				const token = sql.slice(start, i);
				if (!namedIndices.has(token)) namedIndices.set(token, ++maxIndex);
			}
			continue;
		}
		i++;
	}
	return maxIndex;
}

/**
 * Whether `sql` holds more than one statement.
 *
 * `node:sqlite`'s `prepare()` compiles only the first statement of a script and
 * silently drops the rest, whereas `bun:sqlite` executed the whole script. A
 * semicolon outside quotes/comments followed by more tokens therefore marks a
 * script that must run through `exec()`. Trigger bodies (`BEGIN … END`) count as
 * a script here too; `exec()` runs them identically.
 */
function hasMultipleStatements(sql: string): boolean {
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (ch === "'" || ch === '"' || ch === "`") {
			i++;
			while (i < sql.length) {
				if (sql[i] !== ch) {
					i++;
					continue;
				}
				if (sql[i + 1] === ch) {
					i += 2;
					continue;
				}
				i++;
				break;
			}
			continue;
		}
		if (ch === "[") {
			while (i < sql.length && sql[i] !== "]") i++;
			i++;
			continue;
		}
		if (ch === "-" && sql[i + 1] === "-") {
			while (i < sql.length && sql[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && sql[i + 1] === "*") {
			i += 2;
			while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		if (ch === ";") {
			let j = i + 1;
			while (j < sql.length && /\s/.test(sql[j]!)) j++;
			return j < sql.length;
		}
		i++;
	}
	return false;
}

function normalizeBinding(value: unknown): string | number | bigint | null | Uint8Array {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (value instanceof Date) return value.toISOString();
	if (
		value instanceof Uint8Array ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint"
	) {
		return value as string | number | bigint | Uint8Array;
	}
	throw new TypeError(`Unsupported SQLite binding: ${typeof value}`);
}

const SQLITE_RESULT_CODE_NAMES: Record<number, string> = {
	1: "SQLITE_ERROR",
	2: "SQLITE_INTERNAL",
	3: "SQLITE_PERM",
	4: "SQLITE_ABORT",
	5: "SQLITE_BUSY",
	6: "SQLITE_LOCKED",
	7: "SQLITE_NOMEM",
	8: "SQLITE_READONLY",
	9: "SQLITE_INTERRUPT",
	10: "SQLITE_IOERR",
	11: "SQLITE_CORRUPT",
	12: "SQLITE_NOTFOUND",
	13: "SQLITE_FULL",
	14: "SQLITE_CANTOPEN",
	15: "SQLITE_PROTOCOL",
	16: "SQLITE_EMPTY",
	17: "SQLITE_SCHEMA",
	18: "SQLITE_TOOBIG",
	19: "SQLITE_CONSTRAINT",
	20: "SQLITE_MISMATCH",
	21: "SQLITE_MISUSE",
	22: "SQLITE_NOLFS",
	23: "SQLITE_AUTH",
	24: "SQLITE_FORMAT",
	25: "SQLITE_RANGE",
	26: "SQLITE_NOTADB",
};

/**
 * Translate `node:sqlite`'s generic `ERR_SQLITE_ERROR` into the Bun-style
 * `SQLITE_*` result code callers classify on, keeping the extended error
 * number on `errno`.
 */
function normalizeSqliteError(error: unknown): unknown {
	if (error === null || typeof error !== "object" || !("code" in error)) return error;
	const sqliteError = error as { code: unknown; errcode?: unknown };
	if (sqliteError.code !== "ERR_SQLITE_ERROR" || typeof sqliteError.errcode !== "number") return error;
	const name = SQLITE_RESULT_CODE_NAMES[sqliteError.errcode & 0xff];
	if (name) Object.assign(sqliteError, { code: name, errno: sqliteError.errcode });
	return error;
}

function normalizeBindings(params: unknown[]): unknown[] {
	if (params.length === 1 && params[0] !== null && typeof params[0] === "object" && !ArrayBuffer.isView(params[0])) {
		const named = params[0] as Record<string, unknown>;
		const out: Record<string, string | number | bigint | null | Uint8Array> = {};
		for (const [key, value] of Object.entries(named)) out[key] = normalizeBinding(value);
		return [out];
	}
	return params.map(normalizeBinding);
}

/** One prepared statement; mirrors `bun:sqlite`'s `Statement`. */
export class Statement<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]> {
	readonly #statement: StatementSync;
	readonly #sql: string;

	constructor(sql: string, statement: StatementSync) {
		this.#sql = sql;
		this.#statement = statement;
	}

	get sql(): string {
		return this.#sql;
	}

	all(...params: Params): Row[] {
		try {
			return this.#statement.all(...(normalizeBindings(params) as never[])) as Row[];
		} catch (error) {
			throw normalizeSqliteError(error);
		}
	}

	get(...params: Params): Row | null {
		try {
			const row = this.#statement.get(...(normalizeBindings(params) as never[])) as Row | undefined;
			return row ?? null;
		} catch (error) {
			throw normalizeSqliteError(error);
		}
	}

	run(...params: Params): RunResult {
		try {
			const result = this.#statement.run(...(normalizeBindings(params) as never[]));
			return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
		} catch (error) {
			throw normalizeSqliteError(error);
		}
	}

	values(...params: Params): unknown[][] {
		const columns = this.#statement.columns().map(column => column.name);
		return this.all(...params).map(row => {
			const record = row as Record<string, unknown>;
			return columns.map(name => record[name]);
		});
	}

	/** Bun's `raw()`: rows as arrays of column values, same order as `values()`. */
	raw(...params: Params): unknown[][] {
		return this.values(...params);
	}

	iterate(...params: Params): IterableIterator<Row> {
		return this.#statement.iterate(...(normalizeBindings(params) as never[])) as IterableIterator<Row>;
	}

	/** Result column names, matching `bun:sqlite`'s `columnNames`. */
	get columnNames(): string[] {
		return this.#statement.columns().map(column => column.name);
	}

	/** Number of bind parameters, matching `bun:sqlite`'s `paramsCount`. */
	get paramsCount(): number {
		return countParameters(this.#sql);
	}

	/** Bun exposes `finalize`; Node's statement is GC-managed. */
	finalize(): void {}

	[Symbol.dispose](): void {
		this.finalize();
	}

	toString(): string {
		return this.#sql;
	}
}

/** `bun:sqlite`'s `Database`, implemented with `node:sqlite`'s `DatabaseSync`. */
export class Database {
	readonly #db: NodeDatabaseSync;
	readonly #filename: string;
	readonly #statements = new Map<string, StatementSync>();
	readonly #strict: boolean;
	#closed = false;

	constructor(filename = ":memory:", options: DatabaseOptions = {}) {
		this.#filename = filename;
		this.#strict = options.strict ?? false;
		this.#db = new (nodeDatabaseSync())(filename, {
			// `readonly` wins when both it and Bun's inverse `readwrite` are given.
			readOnly: options.readonly ?? (options.readwrite === undefined ? false : !options.readwrite),
			timeout: options.timeout,
		});
		// node:sqlite exposes bigint reads per statement (`setReadBigInts`); the
		// database-wide flag Bun had is not part of its API.
	}

	static deserialize(bytes: Uint8Array, options: DatabaseOptions = {}): Database {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sqlite-"));
		const file = path.join(directory, "deserialized.db");
		fs.writeFileSync(file, bytes);
		const database = new Database(file, options);
		database.addCloseListener(() => fs.rmSync(directory, { recursive: true, force: true }));
		return database;
	}

	/** Registered close hooks (deserialize cleanup). */
	readonly #closeListeners: (() => void)[] = [];

	addCloseListener(listener: () => void): void {
		this.#closeListeners.push(listener);
	}

	get filename(): string {
		return this.#filename;
	}

	get strict(): boolean {
		return this.#strict;
	}

	get inTransaction(): boolean {
		// A raw `BEGIN` outside `transaction()` still opens a transaction; Node's
		// binding reports that, Bun and this adapter both honor it.
		const depth = (this as unknown as Record<symbol, number>)[TRANSACTION_DEPTH] ?? 0;
		return this.#db.isTransaction || depth > 0;
	}

	prepare<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<Row, Params> {
		return new Statement<Row, Params>(sql, this.#statementFor(sql));
	}

	query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<Row, Params> {
		return this.prepare<Row, Params>(sql);
	}

	run(sql: string, ...params: unknown[]): RunResult {
		// Bun's `run()` executed every statement in the string; Node's `prepare()`
		// compiles only the first one and silently drops the rest. Scripts (schema
		// bootstraps, trigger DDL) therefore go through `exec()`, which cannot bind
		// parameters — callers only use scripts for DDL, where the result is unused.
		if (params.length === 0 && hasMultipleStatements(sql)) {
			this.exec(sql);
			return { changes: 0, lastInsertRowid: 0 };
		}
		return this.prepare(sql).run(...(flattenBindings(params) as never[]));
	}

	get<Row = unknown>(sql: string, ...params: unknown[]): Row | null {
		return this.prepare<Row>(sql).get(...(flattenBindings(params) as never[]));
	}

	all<Row = unknown>(sql: string, ...params: unknown[]): Row[] {
		return this.prepare<Row>(sql).all(...(flattenBindings(params) as never[]));
	}

	values(sql: string, ...params: unknown[]): unknown[][] {
		return this.prepare(sql).values(...(flattenBindings(params) as never[]));
	}

	exec(sql: string): void {
		try {
			this.#db.exec(sql);
		} catch (error) {
			throw normalizeSqliteError(error);
		}
	}

	/**
	 * Wrap `fn` in a transaction.
	 *
	 * Nested calls use savepoints, matching Bun; the returned function exposes
	 * `deferred`/`immediate`/`exclusive` variants for API compatibility (Node's
	 * binding only issues plain `BEGIN`).
	 */
	transaction<Args extends unknown[], Result>(
		fn: (...args: Args) => Result,
	): ((...args: Args) => Result) & {
		deferred: (...args: Args) => Result;
		immediate: (...args: Args) => Result;
		exclusive: (...args: Args) => Result;
	} {
		const run = (...args: Args): Result => {
			const depth = ((this as unknown as Record<symbol, number>)[TRANSACTION_DEPTH] ?? 0) + 1;
			(this as unknown as Record<symbol, number>)[TRANSACTION_DEPTH] = depth;
			const savepoint = `omp_sp_${depth}`;
			this.#db.exec(depth === 1 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
			try {
				const result = fn(...args);
				if (result instanceof Promise) {
					throw new Error("Database.transaction() does not support async callbacks");
				}
				this.#db.exec(depth === 1 ? "COMMIT" : `RELEASE ${savepoint}`);
				return result;
			} catch (error) {
				try {
					this.#db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}`);
				} catch {}
				throw error;
			} finally {
				(this as unknown as Record<symbol, number>)[TRANSACTION_DEPTH] = depth - 1;
			}
		};
		return Object.assign(run, { deferred: run, immediate: run, exclusive: run });
	}

	/** Snapshot the database as SQLite file bytes. */
	serialize(): Uint8Array {
		if (this.#filename === ":memory:") {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sqlite-dump-"));
			const target = path.join(directory, "snapshot.db");
			try {
				this.#db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
				return new Uint8Array(fs.readFileSync(target));
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		}
		// Flush the WAL so the main file holds every committed page.
		try {
			this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch {}
		return new Uint8Array(fs.readFileSync(this.#filename));
	}

	close(throwOnError = true): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#statements.clear();
		try {
			this.#db.close();
		} catch (error) {
			// Bun's `close(throwOnError)`: default rethrows, `false` swallows.
			if (throwOnError) throw normalizeSqliteError(error);
		} finally {
			for (const listener of this.#closeListeners) listener();
			this.#closeListeners.length = 0;
		}
	}

	[Symbol.dispose](): void {
		this.close();
	}

	loadExtension(path_: string): void {
		this.#db.loadExtension(path_);
	}

	#statementFor(sql: string): StatementSync {
		const cached = this.#statements.get(sql);
		if (cached) return cached;
		try {
			const statement = this.#db.prepare(sql);
			this.#statements.set(sql, statement);
			return statement;
		} catch (error) {
			throw normalizeSqliteError(error);
		}
	}
}

/** Bun accepted a single array argument where callers meant spread bindings. */
function flattenBindings(params: unknown[]): unknown[] {
	return params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
}

export type DatabaseSync = NodeDatabaseSync;
