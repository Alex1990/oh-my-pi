import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { PARENT_WATCHDOG_WORKER_ARG } from "../cli/worker-selectors";
import { WORKER_SELECTOR_KEY } from "@oh-my-pi/pi-utils/worker-host";
import { Worker } from "@oh-my-pi/pi-utils/worker";

/**
 * SIGKILL this process once `parentPid` exits or this process is reparented.
 *
 * Called by `runIpcSubprocessWorker` (cli.ts) for every IPC subprocess worker.
 * Liveness is polled on a dedicated worker thread rather than the main event
 * loop: inference workers pin their main thread inside synchronous native calls
 * (onnxruntime `session.run`) for minutes at a time, and a main-loop watchdog
 * cannot fire until that call returns — leaving a multi-GiB orphan behind a
 * dead parent (issue #14340). The thread is `unref`'d; it never keeps the
 * process alive by itself.
 */
export function startParentWatchdog(parentPid: number): void {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { workerData: { [WORKER_SELECTOR_KEY]: PARENT_WATCHDOG_WORKER_ARG } })
		: new Worker(new URL("./parent-watchdog-worker.ts", import.meta.url).href);
	worker.postMessage(parentPid);
	worker.unref();
}
