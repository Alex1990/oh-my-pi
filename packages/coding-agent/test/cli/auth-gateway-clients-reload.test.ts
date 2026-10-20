import { afterEach, beforeEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hashAuthGatewayToken } from "@oh-my-pi/pi-ai/auth-gateway";
import { createAuthGatewayClientsReloader } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

describe("auth-gateway serve --clients reload", () => {
	let dir = "";

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-clients-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("applies edits, refuses every client while the file is invalid, and recovers once it is fixed", async () => {
		const file = path.join(dir, "clients.json");
		const original = JSON.stringify({ ci: { tokenSha256: hashAuthGatewayToken("ci-token") } });
		await bun.write(file, original);
		const applied: string[][] = [];
		const reload = createAuthGatewayClientsReloader(file, original, clients => {
			applied.push(clients.map(client => client.name));
		});

		await reload();
		expect(applied).toEqual([]);

		await bun.write(
			file,
			JSON.stringify({
				ci: { tokenSha256: hashAuthGatewayToken("ci-token") },
				ops: { tokenSha256: hashAuthGatewayToken("ops-token") },
			}),
		);
		await reload();
		expect(applied).toEqual([["ci", "ops"]]);

		await bun.write(file, '{ "ci": { "tokenSha256": "');
		await reload();
		await reload();
		expect(applied).toEqual([["ci", "ops"], []]);

		// The file the gateway started with is applied again after a failure.
		await bun.write(file, original);
		await reload();
		expect(applied).toEqual([["ci", "ops"], [], ["ci"]]);
	});
});
