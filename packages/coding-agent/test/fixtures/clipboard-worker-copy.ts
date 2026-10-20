// Worker body for clipboard-osc52.test.ts: runs copyToClipboard off the main
// thread, as the computer tool's `clipboard.write` does, and reports what
// reached this worker's stdout and the native backend. The worker has its own
// `process`, so the fakes below do not touch the test runner.
//
// Module namespaces are frozen under Node, so the native backend is replaced by
// a resolution hook rather than a spy: the stub records the copy and reports
// nothing else, exactly like the mocked native module in the main thread.
import { registerHooks } from "node:module";
import { parentPort } from "node:worker_threads";

const globals = globalThis as typeof globalThis & { __ompClipboardCopies?: string[] };

const stdout: string[] = [];
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "write", {
	configurable: true,
	value: (chunk: string | Uint8Array): boolean => {
		stdout.push(typeof chunk === "string" ? chunk : chunk.toString());
		return true;
	},
});

const nativeCopies: string[] = [];
globals.__ompClipboardCopies = nativeCopies;
const nativeStub = `
export const copyToClipboard = text => { globalThis.__ompClipboardCopies.push(text); };
export const readImageFromClipboard = () => null;
export const readTextFromClipboard = () => null;
`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		// Match on the resolved URL too: the repository loader hook may have
		// already rewritten the specifier before this hook sees it.
		if (
			specifier === "@oh-my-pi/pi-natives/clipboard" ||
			(resolved.url.includes("/natives/") && resolved.url.includes("clipboard"))
		) {
			return { url: `data:text/javascript,${encodeURIComponent(nativeStub)}`, shortCircuit: true };
		}
		return resolved;
	},
});

// Dynamic import is load-order critical: `clipboard.ts` binds the native module
// at evaluation time, so the resolution hook above must be installed first.
const { copyToClipboard } = await import("@oh-my-pi/pi-coding-agent/utils/clipboard");

// Fake the platform only after the import graph evaluated: koffi, loaded by the
// pi-utils entry point, resolves its own binary from `process.platform`.
// Linux keeps macOS runs off the real pbcopy; the native write is stubbed.
Object.defineProperty(process, "platform", { value: "linux", configurable: true });

await copyToClipboard("worker probe");
parentPort?.postMessage({ stdout, nativeCopies });
