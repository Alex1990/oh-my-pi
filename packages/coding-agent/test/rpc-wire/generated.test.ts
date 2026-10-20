import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import { generateRpcArtifacts } from "../../scripts/gen-rpc";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

describe("RPC wire artifacts", () => {
	test("committed schema bundle and generated clients match a fresh `bun run gen:rpc`", async () => {
		for (const [file, contents] of generateRpcArtifacts()) {
			expect(await bun.file(file).text(), file).toBe(contents);
		}
	});
});
