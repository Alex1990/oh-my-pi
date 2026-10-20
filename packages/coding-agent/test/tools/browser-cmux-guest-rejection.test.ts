import { nodeSourceFlags } from "../../src/subprocess/worker-client";
import { expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { TS_CHILD_FLAGS } from "./node-flags";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

const probe = `
import { CmuxTab } from "./packages/coding-agent/src/tools/browser/cmux/cmux-tab.ts";
import { runInProcessTab } from "./packages/coding-agent/src/tools/browser/in-process-run.ts";
import { CmuxSocketClient } from "./packages/coding-agent/src/tools/browser/cmux/socket-client.ts";

const cwd = process.cwd();
const tab = new CmuxTab({
	client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-rejection-probe.sock" }),
	surfaceId: "rejection-probe",
});
const session = { cwd, hasUI: false, getSessionFile: () => null };

try {
	await runInProcessTab(tab, {
		code: \`
			const { promise, reject } = Promise.withResolvers();
			reject(new Error("boom"));
			await new Promise(resolve => setTimeout(resolve, 0));
			await promise.catch(() => undefined);
		\`,
		timeoutMs: 10_000,
		session,
		snapshot: { cwd },
	});
	process.stdout.write("unexpected success\\n");
	process.exitCode = 2;
} catch (error) {
	process.stdout.write(\`caught:\${error instanceof Error ? error.message : String(error)}\\n\`);
}
`;

test("cmux guest floating rejection fails the browser run without exiting the host", async () => {
	const proc = bun.spawn([process.execPath, ...nodeSourceFlags(), ...TS_CHILD_FLAGS, "--eval", probe], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe("caught:Unhandled rejection (missing await?): boom\n");
	expect(stderr).not.toContain("[Unhandled Rejection]");
});
