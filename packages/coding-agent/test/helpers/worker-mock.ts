/**
 * Test seam for suites that need to control tab-worker spawning now that
 * `@oh-my-pi/pi-utils/worker` owns the `Worker` implementation (there is no
 * runtime global to patch). Mock the module in the test file:
 *
 * ```ts
 * vi.mock("@oh-my-pi/pi-utils/worker", async () => {
 * 	const actual = await vi.importActual<typeof import("@oh-my-pi/pi-utils/worker")>("@oh-my-pi/pi-utils/worker");
 * 	const { createMockWorker } = await import("../helpers/worker-mock");
 * 	return { ...actual, Worker: createMockWorker(actual.Worker) };
 * });
 * ```
 */
import type { TransferListItem } from "node:worker_threads";
import type { Worker as RealWorker, WorkerOptions } from "@oh-my-pi/pi-utils/worker";

type WorkerCtor = typeof RealWorker;

/** Mutable switches read by the mocked `Worker` constructor. */
export const workerControl = {
	/** When true, constructing a worker throws instead of starting a thread. */
	unavailable: false,
	/** Wrappers handed out so far, oldest first. */
	instances: [] as RealWorker[],
};

export function createMockWorker(Base: WorkerCtor): WorkerCtor {
	return class MockWorker extends EventTarget {
		#inner: RealWorker | null = null;

		constructor(specifier: string | URL, options?: WorkerOptions) {
			super();
			if (workerControl.unavailable) throw new Error("Worker threads unavailable");
			const inner = new Base(specifier, options);
			this.#inner = inner;
			workerControl.instances.push(this as unknown as RealWorker);
			inner.addEventListener("message", event => {
				this.dispatchEvent(new MessageEvent("message", { data: (event as MessageEvent).data }));
			});
			inner.addEventListener("messageerror", event => {
				this.dispatchEvent(new MessageEvent("messageerror", { data: (event as MessageEvent).data }));
			});
			inner.addEventListener("error", event => {
				const failure = event as Event & { message?: string; error?: unknown };
				const forwarded = new Event("error") as Event & { message: string; error: unknown };
				forwarded.message = failure.message ?? "Unknown worker error";
				forwarded.error = failure.error;
				this.dispatchEvent(forwarded);
			});
			inner.addEventListener("close", event => {
				const forwarded = new Event("close") as Event & { code: number };
				forwarded.code = (event as Event & { code: number }).code;
				this.dispatchEvent(forwarded);
			});
		}

		postMessage(value: unknown, transfer: readonly TransferListItem[] = []): void {
			this.#inner?.postMessage(value, transfer);
		}

		terminate(): Promise<number> {
			return this.#inner?.terminate() ?? Promise.resolve(0);
		}

		ref(): void {
			this.#inner?.ref();
		}

		unref(): void {
			this.#inner?.unref();
		}
	} as unknown as WorkerCtor;
}
