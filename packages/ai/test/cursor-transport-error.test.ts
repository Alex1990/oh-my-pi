import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { nodeTsArgs } from "./helpers/node-ts";

describe("Cursor transport errors", () => {
	it("surfaces a TLS handshake reset as a stream error", async () => {
		const child = bun.spawn(nodeTsArgs(path.join(import.meta.dirname, "fixtures/cursor-tls-reset.ts")), {
			cwd: path.resolve(import.meta.dirname, "../../.."),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({
			eventTypes: ["start", "error"],
			stopReason: "error",
		});
	}, 60_000);
});
