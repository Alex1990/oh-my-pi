import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { nodeTsArgs } from "./helpers/node-ts";

const STATIC_IMPORT_FIXTURE = `${import.meta.dirname}/fixtures/oauth-barrel-import.ts`;

describe("OAuth barrel imports", () => {
	it("loads with the Anthropic provider and auth storage while preserving public exports", async () => {
		const child = bun.spawn(nodeTsArgs(STATIC_IMPORT_FIXTURE), {
			cwd: import.meta.dirname,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

		expect(exitCode, stderr).toBe(0);
	}, 60_000);
});
