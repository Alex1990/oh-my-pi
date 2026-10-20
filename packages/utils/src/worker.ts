/**
 * Web-Worker-shaped `Worker` over `node:worker_threads`.
 *
 * Bun exposed a browser-compatible `Worker` (EventTarget with `message`,
 * `error`, `messageerror`, and `close` events). Node's thread worker is an
 * EventEmitter with `exit` instead of `close`, so this adapter keeps the call
 * sites unchanged while forwarding both shapes.
 */
import { Worker as NodeWorker, type TransferListItem, type WorkerOptions } from "node:worker_threads";

export type { WorkerOptions };

/** Error event matching the Web `ErrorEvent` surface the call sites read. */
export class WorkerErrorEvent extends Event {
	readonly message: string;
	readonly error: unknown;

	constructor(message: string, error: unknown) {
		super("error");
		this.message = message;
		this.error = error;
	}
}

export class Worker extends EventTarget {
	readonly #worker: NodeWorker;

	constructor(specifier: string | URL, options: WorkerOptions = {}) {
		super();
		this.#worker = new NodeWorker(specifier, options);
		this.#worker.on("message", data => {
			this.dispatchEvent(new MessageEvent("message", { data }));
		});
		this.#worker.on("messageerror", error => {
			this.dispatchEvent(new MessageEvent("messageerror", { data: error }));
		});
		this.#worker.on("error", error => {
			this.dispatchEvent(new WorkerErrorEvent(error.message, error));
		});
		this.#worker.on("exit", code => {
			const event = new Event("close") as Event & { code: number };
			event.code = code;
			this.dispatchEvent(event);
		});
	}

	postMessage(value: unknown, transfer: readonly TransferListItem[] = []): void {
		this.#worker.postMessage(value, transfer as never);
	}

	terminate(): Promise<number> {
		return this.#worker.terminate();
	}

	ref(): void {
		this.#worker.ref();
	}

	unref(): void {
		this.#worker.unref();
	}

	/** Underlying thread worker, for callers that need Node-specific controls. */
	get thread(): NodeWorker {
		return this.#worker;
	}
}
