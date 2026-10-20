import { spawn } from "node:child_process";
import { parentPort } from "node:worker_threads";
import { installWorkerInbox, WORKER_HOST_SELECTOR_PREFIX } from "@oh-my-pi/pi-utils/worker-host";
import { COMPUTER_WORKER_ARG } from "../../src/tools/computer/protocol";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const STATS_WORKER_ARG = `${WORKER_HOST_SELECTOR_PREFIX}stats_sync`;

const selector = process.argv.find(arg => arg.startsWith(WORKER_HOST_SELECTOR_PREFIX));

if (selector === COMPUTER_WORKER_ARG) {
	if (!parentPort) throw new Error("compiled worker fixture: missing parentPort");
	installWorkerInbox(parentPort);
	// Runtime-selected by the worker selector; the compiled host must keep it lazy.
	await import("../../src/tools/computer/worker-entry");
} else if (selector === STATS_WORKER_ARG) {
	const port = parentPort;
	if (port) {
		port.on("message", () => {
			port.postMessage({ ok: true, kind: "pong" });
		});
	} else {
		process.stdout.write('{"ok":true,"kind":"pong"}\n');
	}
} else if (bun.isMainThread) {
	// Re-enter the compiled executable with a selector, the way the CLI worker
	// host dispatches. Bun's `node:worker_threads` cannot use the executable
	// itself as a worker entry, so a subprocess plays that role here.
	const child = spawn(process.execPath, [STATS_WORKER_ARG], { stdio: "inherit" });
	child.on("exit", code => process.exit(code ?? 1));
} else {
	throw new Error(`unknown worker selector: ${selector}`);
}
