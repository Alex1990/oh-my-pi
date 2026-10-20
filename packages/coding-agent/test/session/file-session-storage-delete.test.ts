import { afterEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

describe("FileSessionStorage.deleteSessionWithArtifacts", () => {
	let tmpRoot = "";

	afterEach(async () => {
		if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
		tmpRoot = "";
	});

	it("removes stale .bak siblings so the picker cannot resurrect the session (issue #11499)", async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-delete-bak-"));
		const sessionPath = path.join(tmpRoot, "2026-09-21T00-00-00-000Z_abc123.jsonl");
		await bun.write(sessionPath, '{"type":"session"}\n');
		const ownBak = `${sessionPath}.999.bak`;
		const otherBak = path.join(tmpRoot, "other.jsonl.111.bak");
		await bun.write(ownBak, "stale backup");
		await bun.write(otherBak, "unrelated backup");

		const storage = new FileSessionStorage();
		await storage.deleteSessionWithArtifacts(sessionPath);

		expect(await bun.file(sessionPath).exists()).toBe(false);
		expect(await bun.file(ownBak).exists()).toBe(false);
		expect(await bun.file(otherBak).exists()).toBe(true);
	});
});
