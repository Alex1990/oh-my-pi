import { Database } from "@oh-my-pi/pi-utils/sqlite-compat";
import { describe, expect, it, spyOn } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import * as fs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, removeWithRetries } from "@oh-my-pi/pi-utils/temp";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const rmMock = vi.hoisted(() => ({ attempts: 0 }));

// Node's ESM namespace objects are frozen, so replace the `rm` binding through
// a module mock instead of `spyOn(fsPromises, "rm")`.
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof NodeFsPromises>();
	const rm = (async (...args: Parameters<typeof actual.rm>) => {
		rmMock.attempts++;
		if (rmMock.attempts === 1) {
			const err = new Error("resource busy or locked") as NodeJS.ErrnoException;
			err.code = "EBUSY";
			throw err;
		}
		return actual.rm(...args);
	}) as typeof actual.rm;
	return { ...actual, rm };
});

// Retries are Windows-only by design (`shouldRetryRemove` gates on
// `process.platform === "win32"`), so the locked-removal path only exists there.
describe.skipIf(process.platform !== "win32")("locked temp directory removal", () => {
	// bun on Windows keeps a closed SQLite database's file handles open until
	// every statement prepared on it is finalized, and a leaked statement is only
	// finalized by GC. Nothing collects during a blocking retry loop, so without a
	// forced collection the directory stays locked past the whole retry window
	// and removeSyncWithRetries throws EBUSY.
	it("removeSyncWithRetries deletes a closed SQLite database whose statement was never finalized", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-remove-"));
		openAndCloseLeakingStatement(path.join(dir, "store.db"));
		try {
			removeSyncWithRetries(dir);
			expect(fs.existsSync(dir)).toBe(false);
		} finally {
			bun.gc(true);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// The async loop yields to the event loop, where bun eventually collects on
	// its own, so the same leak only costs a ~1 s stall there instead of a
	// failure. Assert the forced collection directly.
	it("removeWithRetries forces a major GC before the first retry", async () => {
		const target = fs.mkdtempSync(path.join(os.tmpdir(), "pi-temp-remove-"));
		rmMock.attempts = 0;
		const gc = spyOn(bun, "gc");

		try {
			await removeWithRetries(target);
			expect(rmMock.attempts).toBe(2);
			expect(gc).toHaveBeenCalledTimes(1);
		} finally {
			gc.mockRestore();
			fs.rmSync(target, { recursive: true, force: true });
		}
	});
});

function openAndCloseLeakingStatement(dbPath: string): void {
	const db = new Database(dbPath);
	db.run("PRAGMA journal_mode = WAL");
	db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
	db.run("INSERT INTO kv VALUES ('a', '1')");
	db.prepare("SELECT value FROM kv WHERE key = ?").get("a");
	db.close();
}
