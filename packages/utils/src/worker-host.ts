import { workerData } from "node:worker_threads";
import { stripWindowsExtendedLengthPathPrefix } from "./path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

/** Prefix reserved for argv selectors dispatched by the shared CLI worker host. */
export const WORKER_HOST_SELECTOR_PREFIX = "__omp_worker_";

/** `workerData` key that carries the selector into a Node worker thread. */
export const WORKER_SELECTOR_KEY = "__ompWorkerSelector";

/** Whether an argv value selects a worker hosted by the shared CLI entrypoint. */
export function isWorkerHostSelector(value: string | undefined): value is string {
	return value?.startsWith(WORKER_HOST_SELECTOR_PREFIX) ?? false;
}

/**
 * Main-module path declared by self-dispatching CLI entrypoints — entries
 * whose top-level argv handling routes hidden `__omp_*` worker selectors.
 * Worker spawn sites re-enter this module with `workerData[WORKER_SELECTOR_KEY]`
 * set (Node's `Worker` has no `argv` option), so every distribution (source,
 * npm bundle, launcher) needs exactly one JavaScript entrypoint. Never set
 * under a test runner, SDK embedding, or standalone package bins — those hosts
 * load worker modules directly.
 */
let workerHostMain: string | null = null;

/** Called by CLI entrypoints whose main module dispatches worker argv selectors. */
export function declareWorkerHostEntry(): void {
	workerHostMain = stripWindowsExtendedLengthPathPrefix(bun.main);
}

/** Main-module path of the self-dispatching CLI host, or null outside it. */
export function workerHostEntry(): string | null {
	return workerHostMain;
}

/**
 * Selector this process was started for: `workerData` in a worker thread, or
 * the hidden argv entry when a subprocess re-enters the CLI.
 */
export function workerSelector(): string | undefined {
	const data = workerData;
	if (data && typeof data === "object" && WORKER_SELECTOR_KEY in data) {
		const value = (data as Record<string, unknown>)[WORKER_SELECTOR_KEY];
		return typeof value === "string" ? value : undefined;
	}
	return process.argv[2];
}

/**
 * Buffers messages a worker thread receives before its real handler is
 * attached, then hands them off once it is.
 *
 * The self-dispatching CLI host imports each worker module dynamically from
 * inside its worker-selector dispatch. Node buffers `parentPort` messages until
 * a listener exists, but a listener installed by the dynamically imported
 * module still lands after the parent has already posted its synchronous `init`
 * handshake; buffering here keeps that handshake ordered ahead of the module's
 * own handler regardless of import timing.
 *
 * The host calls {@link installWorkerInbox} in the entry's sync prefix (before
 * importing the worker module) so a `parentPort` listener exists early; the
 * worker module then {@link consumeWorkerInbox}es it and binds the real
 * handler, replaying anything buffered.
 */
export interface WorkerInbox {
	/** Route buffered and subsequent messages to `handler`; returns an unbind fn. */
	bind(handler: (message: unknown) => void): () => void;
}

/** Minimal `parentPort` surface the inbox needs (Node/Bun `MessagePort`). */
interface MessageListenerPort {
	on(event: "message", listener: (value: unknown) => void): unknown;
}

let pendingInbox: WorkerInbox | null = null;

/**
 * Attach a buffering `message` listener on `port` synchronously and stash the
 * resulting inbox for the worker module to {@link consumeWorkerInbox}. MUST be
 * called in the entry module's synchronous prefix — before the worker module is
 * imported — so the listener exists when Bun flushes pre-spawn messages.
 */
export function installWorkerInbox(port: MessageListenerPort): WorkerInbox {
	const queue: unknown[] = [];
	let handler: ((message: unknown) => void) | null = null;
	port.on("message", (data: unknown) => {
		if (handler) handler(data);
		else queue.push(data);
	});
	const inbox: WorkerInbox = {
		bind(next) {
			handler = next;
			for (const data of queue) next(data);
			queue.length = 0;
			return () => {
				if (handler === next) handler = null;
			};
		},
	};
	pendingInbox = inbox;
	return inbox;
}

/**
 * Take the inbox installed by {@link installWorkerInbox} for this worker, or
 * `null` when the worker module was loaded directly (no host pre-buffering, so
 * the module's own synchronous top-level listener already wins the flush).
 */
export function consumeWorkerInbox(): WorkerInbox | null {
	const inbox = pendingInbox;
	pendingInbox = null;
	return inbox;
}
