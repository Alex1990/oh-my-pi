import { withFileLock } from "../../src/file-lock";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const target = bun.argv[2];
const readyPath = bun.argv[3];
if (!target || !readyPath) throw new Error("file-lock-holder requires target and readiness paths");

await withFileLock(
	target,
	async () => {
		await bun.write(readyPath, "ready");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	},
	{ retries: 1, retryDelayMs: 0 },
);
