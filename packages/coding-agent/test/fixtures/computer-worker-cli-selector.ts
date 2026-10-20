import { Worker, type WorkerErrorEvent } from "@oh-my-pi/pi-utils/worker";
import { nodeSourceFlags } from "../../src/subprocess/worker-client";
const worker = new Worker(new URL("../../src/cli.ts", import.meta.url), {
	argv: ["__omp_worker_computer"],
	execArgv: nodeSourceFlags(),
});
const response = Promise.withResolvers<unknown>();
worker.addEventListener("message", event => {
	const data = (event as MessageEvent).data as { type?: string; id?: string } | undefined;
	if (data?.type === "pong" && data.id === "computer-cli-selector") response.resolve(data);
});
worker.addEventListener("error", event => {
	const failure = event as WorkerErrorEvent;
	response.reject(failure.error ?? new Error(failure.message));
});
worker.postMessage({ type: "ping", id: "computer-cli-selector" });
try {
	process.stdout.write(`${JSON.stringify(await response.promise)}\n`);
} finally {
	worker.terminate();
}
