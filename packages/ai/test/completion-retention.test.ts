import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { nodeTsArgs } from "./helpers/node-ts";

describe("completion event retention", () => {
	for (const completion of ["complete", "completeSimple"]) {
		for (const outcome of ["success", "failure"]) {
			test(`${completion} releases events before ${outcome} settles the response`, async () => {
				const child = bun.spawn(
					nodeTsArgs(
						path.join(import.meta.dirname, "fixtures/completion-retention.ts"),
						completion,
						outcome,
					),
					{ stdout: "pipe", stderr: "pipe" },
				);
				const timeout = setTimeout(() => child.kill(), 10_000);
				try {
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "verified\n" });
				} finally {
					clearTimeout(timeout);
					child.kill();
					await child.exited;
				}
			}, 15_000);
		}
	}
});
