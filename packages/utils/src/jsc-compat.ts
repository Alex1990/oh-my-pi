/**
 * `bun:jsc` replacement.
 *
 * Bun exposed JavaScriptCore internals (`heapStats`, `startRemoteDebugger`) that
 * have V8-side equivalents: `v8.getHeapStatistics()` and `inspector.open()`.
 */
import { open as openInspector, waitForDebugger } from "node:inspector";
import * as v8 from "node:v8";

export interface HeapStats {
	heapSize: number;
	heapCapacity: number;
	extraMemorySize: number;
	objectCount: number;
	protectedObjectCount: number;
}

/** V8 heap counters in Bun's `HeapStats` shape. */
export function heapStats(): HeapStats {
	const statistics = v8.getHeapStatistics();
	return {
		heapSize: statistics.used_heap_size,
		heapCapacity: statistics.total_heap_size,
		extraMemorySize: statistics.external_memory,
		objectCount: statistics.number_of_native_contexts,
		protectedObjectCount: statistics.number_of_detached_contexts,
	};
}

export interface RemoteDebuggerOptions {
	host?: string;
	port?: number;
	/** Block until a debugger attaches. */
	wait?: boolean;
}

/**
 * Start the Node inspector on demand.
 *
 * Bun could open a WebKit remote-debugging socket at runtime; Node's equivalent
 * is the V8 inspector, reachable at `chrome://inspect` or `node inspect`.
 */
export function startRemoteDebugger(options: RemoteDebuggerOptions = {}): string {
	const port = options.port ?? 6499;
	openInspector(port, options.host ?? "127.0.0.1", options.wait ?? false);
	if (options.wait) waitForDebugger();
	return `http://${options.host ?? "127.0.0.1"}:${port}`;
}
