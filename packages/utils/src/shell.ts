/**
 * `$` (Bun Shell) replacement.
 *
 * Bun embedded its own cross-platform shell interpreter. Running on Node means
 * executing through the platform shell (`cmd.exe` on Windows, `/bin/sh`
 * elsewhere), with interpolated values escaped as single arguments — the
 * subset of Bun Shell behavior the repository relies on.
 *
 * Chained configuration (`cwd`, `env`, `quiet`, `nothrow`, …) is buffered and
 * applied when the command actually runs, which happens on `await`/`.then()`
 * or on an explicit output accessor.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface ShellOutput {
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	text(encoding?: BufferEncoding): string;
	json<T = unknown>(): T;
	lines(): string[];
	blob(): Blob;
	arrayBuffer(): ArrayBuffer;
}

export interface ShellOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	quiet?: boolean;
	nothrow?: boolean;
	stdin?: string | Uint8Array | null;
	timeout?: number;
	windowsHide?: boolean;
}

/** `Bun.ShellError`-shaped failure raised for non-zero exits. */
export class ShellError extends Error {
	readonly exitCode: number | null;
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly command: string;

	constructor(command: string, output: { exitCode: number | null; stdout: Buffer; stderr: Buffer }) {
		super(
			`Command failed with exit code ${output.exitCode}: ${command}\n${output.stderr.toString("utf8").trim()}`.trim(),
		);
		this.name = "ShellError";
		this.command = command;
		this.exitCode = output.exitCode;
		this.stdout = output.stdout;
		this.stderr = output.stderr;
	}
}

function quote(value: unknown): string {
	if (Array.isArray(value)) return value.map(entry => quote(entry)).join(" ");
	if (value === null || value === undefined) return "";
	const text = typeof value === "object" && "raw" in value ? String((value as { raw: unknown }).raw) : String(value);
	if (process.platform === "win32") {
		// cmd.exe: wrap in double quotes, escaping embedded quotes.
		return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `"${text.replaceAll('"', '""')}"`;
	}
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

function renderCommand(strings: TemplateStringsArray, values: unknown[]): string {
	let command = "";
	for (let index = 0; index < strings.length; index++) {
		command += strings[index];
		if (index < values.length) command += quote(values[index]);
	}
	return command;
}

// oxlint-disable-next-line unicorn/no-thenable -- Bun's `$` returns an awaitable command builder.
class ShellPromise implements PromiseLike<ShellOutput> {
	readonly #command: string;
	readonly #options: ShellOptions;
	#execution: Promise<ShellOutput> | null = null;

	constructor(command: string, options: ShellOptions = {}) {
		this.#command = command;
		this.#options = options;
	}

	cwd(directory: string): ShellPromise {
		return new ShellPromise(this.#command, { ...this.#options, cwd: directory });
	}

	env(values: Record<string, string | undefined>): ShellPromise {
		return new ShellPromise(this.#command, { ...this.#options, env: { ...this.#options.env, ...values } });
	}

	quiet(): ShellPromise {
		return new ShellPromise(this.#command, { ...this.#options, quiet: true });
	}

	nothrow(): ShellPromise {
		return new ShellPromise(this.#command, { ...this.#options, nothrow: true });
	}

	throws(enabled: boolean): ShellPromise {
		return new ShellPromise(this.#command, { ...this.#options, nothrow: !enabled });
	}

	stdin(input: string | Uint8Array): ShellPromise {
		return new ShellPromise(this.#command, { ...this.#options, stdin: input });
	}

	timeout(milliseconds: number): ShellPromise {
		return new ShellPromise(this.#command, { ...this.#options, timeout: milliseconds });
	}

	then<TResult1 = ShellOutput, TResult2 = never>(
		onfulfilled?: ((value: ShellOutput) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		return this.#run().then(onfulfilled, onrejected);
	}

	catch<TResult = never>(
		onrejected: (reason: unknown) => TResult | PromiseLike<TResult>,
	): Promise<ShellOutput | TResult> {
		return this.#run().catch(onrejected);
	}

	async text(encoding: BufferEncoding = "utf8"): Promise<string> {
		// Bun Shell's `text()` decodes stdout verbatim; callers trim when they want to.
		return (await this.#run()).stdout.toString(encoding);
	}

	async json<T = unknown>(): Promise<T> {
		return JSON.parse(await this.text()) as T;
	}

	async blob(): Promise<Blob> {
		return (await this.#run()).blob();
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return (await this.#run()).arrayBuffer();
	}

	async lines(): Promise<string[]> {
		const text = await this.text();
		return text.length === 0 ? [] : text.split(/\r?\n/);
	}

	#run(): Promise<ShellOutput> {
		this.#execution ??= runCommand(this.#command, this.#options);
		return this.#execution;
	}
}

function runCommand(command: string, options: ShellOptions): Promise<ShellOutput> {
	const { promise, resolve, reject } = Promise.withResolvers<ShellOutput>();
	const isWindows = process.platform === "win32";
	const child: ChildProcessWithoutNullStreams = spawn(
		isWindows ? command : "/bin/sh",
		isWindows ? [] : ["-c", command],
		{
			// Let Node build the `cmd.exe /d /s /c "…"` line: passing the quotes
			// ourselves makes Node escape them (`\"…\"`) and cmd sees a literal
			// command name.
			shell: isWindows,
			cwd: options.cwd,
			env: options.env as NodeJS.ProcessEnv | undefined,
			windowsHide: options.windowsHide ?? true,
		},
	);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (chunk: Buffer) => {
		stdout.push(chunk);
		if (!options.quiet) process.stdout.write(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr.push(chunk);
		if (!options.quiet) process.stderr.write(chunk);
	});
	if (options.stdin !== undefined && options.stdin !== null) child.stdin.end(options.stdin);
	else child.stdin.end();
	let timer: NodeJS.Timeout | undefined;
	if (options.timeout !== undefined) {
		timer = setTimeout(() => child.kill("SIGKILL"), options.timeout);
		timer.unref?.();
	}
	child.on("error", error => {
		clearTimeout(timer);
		reject(error);
	});
	child.on("close", exitCode => {
		clearTimeout(timer);
		const output = toOutput(exitCode, child.signalCode, Buffer.concat(stdout), Buffer.concat(stderr));
		if (exitCode !== 0 && !options.nothrow) reject(new ShellError(command, output));
		else resolve(output);
	});
	return promise;
}

function toOutput(
	exitCode: number | null,
	signalCode: NodeJS.Signals | null,
	stdout: Buffer,
	stderr: Buffer,
): ShellOutput {
	return {
		exitCode,
		signalCode,
		stdout,
		stderr,
		text: (encoding: BufferEncoding = "utf8") => stdout.toString(encoding),
		json: <T = unknown>() => JSON.parse(stdout.toString("utf8")) as T,
		lines: () => (stdout.length === 0 ? [] : stdout.toString("utf8").trim().split(/\r?\n/)),
		blob: () => new Blob([new Uint8Array(stdout)]),
		arrayBuffer: () => stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength) as ArrayBuffer,
	};
}

/** `$` — run a shell command through the platform shell. */
export function $(strings: TemplateStringsArray, ...values: unknown[]): ShellPromise {
	return new ShellPromise(renderCommand(strings, values));
}

/** Escape one value for the platform shell, matching `$.escape`. */
$.escape = quote;

/** Run a command string without the template-literal syntax. */
$.raw = (command: string, options?: ShellOptions): ShellPromise => new ShellPromise(command, options);

export type { ShellPromise };
