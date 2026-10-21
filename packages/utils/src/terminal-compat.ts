/**
 * `Bun.Terminal` replacement backed by the native `PtySession`.
 *
 * Bun could allocate a pseudo-terminal and attach `Bun.spawn` to it; the native
 * module already owns PTY creation, so this class wraps `PtySession` in Bun's
 * callback shape (`data` / `exit`) and exposes {@link Terminal.spawn} for
 * `bun.spawn(cmd, { terminal })` call sites.
 */
import { PtySession } from "@oh-my-pi/pi-natives";
import type { SpawnOptions, Subprocess } from "./node-runtime";

export interface TerminalOptions {
	cols?: number;
	rows?: number;
	name?: string;
	data?(terminal: Terminal, data: Uint8Array): void;
	exit?(terminal: Terminal, exitCode: number, signalCode?: number | null): void;
	drain?(terminal: Terminal): void;
}

const encoder = new TextEncoder();

/** One PTY attachment, shaped like `Bun.Terminal`. */
export class Terminal {
	cols: number;
	rows: number;
	readonly name: string;
	readonly #handlers: TerminalOptions;
	#session: PtySession | null = null;
	#closed = false;

	constructor(options: TerminalOptions = {}) {
		this.cols = options.cols ?? 80;
		this.rows = options.rows ?? 24;
		this.name = options.name ?? "oyp-terminal";
		this.#handlers = options;
	}

	write(data: string): void {
		this.#session?.write(data);
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		this.#session?.resize(cols, rows);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#session?.kill();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.close();
	}

	/** Start `command` under this PTY and return a `Bun.Subprocess`-shaped handle. */
	spawn(command: string[], options: SpawnOptions = {}): Subprocess {
		const session = new PtySession();
		this.#session = session;
		const deferred = Promise.withResolvers<number | null>();
		const terminal = this;
		let pidValue = -1;
		const result = session
			.startArgv(
				{
					application: command[0],
					args: command.slice(1),
					cwd: options.cwd,
					env: options.env as Record<string, string> | undefined,
					cols: this.cols,
					rows: this.rows,
				},
				(error, chunk) => {
					if (error) return;
					terminal.#handlers.data?.(terminal, encoder.encode(chunk));
				},
				(_error, pid) => {
					pidValue = pid;
				},
			)
			.then(outcome => {
				const exitCode = outcome.exitCode ?? (outcome.cancelled ? 130 : 0);
				terminal.#handlers.exit?.(terminal, exitCode, null);
				deferred.resolve(exitCode);
				return exitCode;
			})
			.catch(error => {
				terminal.#handlers.exit?.(terminal, 1, null);
				deferred.reject(error);
				throw error;
			});

		const handle = {
			terminal,
			get pid() {
				return pidValue;
			},
			get exited() {
				return deferred.promise;
			},
			get stdin() {
				return null;
			},
			get stdout() {
				return null;
			},
			get stderr() {
				return null;
			},
			signalCode: null as string | null,
			kill(): void {
				session.kill();
			},
			ref(): void {},
			unref(): void {},
			async output() {
				const exitCode = await deferred.promise;
				return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode, signalCode: null };
			},
			async [Symbol.asyncDispose]() {
				session.kill();
				await result;
			},
		} as unknown as Subprocess;
		return handle;
	}
}
