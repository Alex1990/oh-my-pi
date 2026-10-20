/**
 * `Bun.SQL` replacement for the SQLite dialect.
 *
 * Bun shipped a multi-dialect SQL client. On Node the durable, dependency-free
 * engine is the built-in `node:sqlite`, so this class implements the same
 * `unsafe` / `transaction` / `end` / `options.adapter` surface for `sqlite:`
 * URLs and reports a clear error for Postgres/MySQL URLs — callers that need
 * those engines construct a `pg`/`mysql2`-backed client satisfying
 * `SqlSessionStorageClient` instead.
 */
import { Database } from "./sqlite-compat";

/** Result array with optional mutation metadata, matching Bun's SQL result. */
export interface SqlResult extends Array<Record<string, unknown>> {
	affectedRows?: number;
}

export interface SqlClientOptions {
	adapter: "sqlite" | string;
	[key: string]: unknown;
}

/** Transaction-scoped handle. */
export interface SqlTransaction {
	unsafe(query: string, values?: unknown[]): Promise<SqlResult>;
}

export class SQL implements SqlTransaction {
	readonly options: SqlClientOptions;
	readonly #database: Database;
	#closed = false;

	constructor(url: string) {
		const parsed = parseSqliteUrl(url);
		this.options = { adapter: "sqlite", url };
		this.#database = new Database(parsed);
	}

	async unsafe(query: string, values: unknown[] = []): Promise<SqlResult> {
		if (this.#closed) throw new Error("SQL: client is closed");
		const statement = this.#database.prepare(query);
		const trimmed = query.trimStart().toUpperCase();
		const returnsRows =
			trimmed.startsWith("SELECT") ||
			trimmed.startsWith("WITH") ||
			trimmed.startsWith("PRAGMA") ||
			trimmed.startsWith("EXPLAIN") ||
			// `INSERT … RETURNING` / `UPDATE … RETURNING` produce rows, exactly as
			// Bun's SQL did. `node:sqlite`'s `run()` discards them, so route these
			// through `all()` or callers that probe `result.length` see a no-op.
			/\bRETURNING\b/.test(trimmed);
		if (returnsRows) {
			return statement.all(...(values as never[])) as SqlResult;
		}
		const result = statement.run(...(values as never[]));
		const rows = [] as unknown as SqlResult;
		rows.affectedRows = Number(result.changes);
		return rows;
	}

	async transaction<T>(callback: (transaction: SqlTransaction) => Promise<T>): Promise<T> {
		this.#database.exec("BEGIN");
		try {
			const result = await callback(this);
			this.#database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.#database.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}

	async end(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#database.close();
	}
}

/** Resolve `sqlite:<path>` / `sqlite::memory:` into a `node:sqlite` filename. */
function parseSqliteUrl(url: string): string {
	if (!url.startsWith("sqlite:")) {
		const scheme = url.slice(0, url.indexOf(":"));
		throw new Error(
			`SQL: the Node runtime only implements the sqlite dialect (got "${scheme}"); ` +
				"construct a pg/mysql2-backed SqlSessionStorageClient for those engines",
		);
	}
	const rest = url.slice("sqlite:".length);
	if (rest.length === 0 || rest === ":memory:" || rest === "//:memory:") return ":memory:";
	return rest.replace(/^\/\//, "");
}
