import { afterEach, beforeEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLspWritethrough } from "../../src/lsp";
import { FileFormatResult } from "@oh-my-pi/pi-tui/tools/lsp";
import { configCache } from "../../src/lsp/config";
import type { LinterClient, ServerConfig } from "../../src/lsp/types";
import { addFileWriteFallback } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { TempDir } from "@oh-my-pi/pi-utils";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

function createFormatter(format: (filePath: string, content: string) => Promise<string>): ServerConfig {
	return {
		command: "test-formatter",
		fileTypes: ["ts"],
		rootMarkers: [],
		createClient: () =>
			({
				format,
				lint: async () => [],
			}) satisfies LinterClient,
	};
}

describe("createLspWritethrough batching", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-lsp-batch-");
		configCache.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		configCache.clear();
		tempDir.removeSync();
	});

	it("defers LSP work until the batch flush", async () => {
		const formatted: string[] = [];
		const formatter = createFormatter(async (filePath, content) => {
			formatted.push(filePath);
			return content;
		});
		configCache.set(tempDir.path(), { servers: { formatter }, idleTimeoutMs: undefined });
		const cached = vi.spyOn(configCache, "get");
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `batch-${Date.now()}`;

		const firstResult = await writethrough(fileA, "const a = 1;\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});

		expect(firstResult.finalContent).toBe("const a = 1;\n");
		expect(formatted).toEqual([]);
		expect(cached).toHaveBeenCalledTimes(0);
		expect(await bun.file(fileA).text()).toBe("const a = 1;\n");

		const secondResult = await writethrough(fileB, "const b = 2;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(secondResult.finalContent).toBe("const b = 2;\n");
		expect(formatted).toEqual([fileA, fileB]);
		// Each buffered entry probes the prefilled cache; `loadConfig` never runs because
		// the config was resolved once up front.
		expect(cached).toHaveBeenCalledTimes(2);
		expect(await bun.file(fileA).text()).toBe("const a = 1;\n");
		expect(await bun.file(fileB).text()).toBe("const b = 2;\n");
	});

	it("preserves a newer external change made before the batch flush", async () => {
		configCache.set(tempDir.path(), { servers: {}, idleTimeoutMs: undefined });
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `external-change-${Date.now()}`;
		await writethrough(fileA, "const value = 'tool';\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});

		await bun.write(fileA, "const value = 'external';\n");
		await writethrough(fileB, "const other = true;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(await bun.file(fileA).text()).toBe("const value = 'external';\n");
		expect(await bun.file(fileB).text()).toBe("const other = true;\n");
	});

	it("does not recreate a file deleted before the batch flush", async () => {
		configCache.set(tempDir.path(), { servers: {}, idleTimeoutMs: undefined });
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `external-delete-${Date.now()}`;
		await writethrough(fileA, "const removed = true;\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});

		await fs.unlink(fileA);
		await writethrough(fileB, "const survivor = true;\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(await bun.file(fileA).exists()).toBe(false);
		expect(await bun.file(fileB).text()).toBe("const survivor = true;\n");
	});

	it("preserves a UTF-8 BOM when batch formatting changes content", async () => {
		const formatter = createFormatter(async (_filePath, content) => content.replace("=1", " = 1;"));
		configCache.set(tempDir.path(), { servers: { formatter }, idleTimeoutMs: undefined });
		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `bom-${Date.now()}`;
		await writethrough(fileA, "\uFEFFconst value=1\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});
		const result = await writethrough(fileB, "const other=1\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});
		expect(result.finalContent).toBe("const other = 1;\n");

		const bytes = new Uint8Array(await bun.file(fileA).arrayBuffer());
		expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(Buffer.from(bytes).toString("utf8")).toBe("\uFEFFconst value = 1;\n");
	});
	it("preserves formatter failures when merging batch results", async () => {
		const formatter = createFormatter(async () => {
			throw new Error("formatter crashed");
		});
		configCache.set(tempDir.path(), { servers: { "broken-formatter": formatter }, idleTimeoutMs: undefined });
		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});

		const batchId = "formatter-failure";
		await writethrough(path.join(tempDir.path(), "a.ts"), "const a=1\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});
		const result = await writethrough(path.join(tempDir.path(), "b.ts"), "const b=1\n", undefined, undefined, {
			id: batchId,
			flush: true,
		});

		expect(result.diagnostics?.formatter).toBe(FileFormatResult.FAILED);
	});

	it("flushes earlier entries when the final batch write fails", async () => {
		const formatted: string[] = [];
		const formatter = createFormatter(async (filePath, content) => {
			formatted.push(filePath);
			return content;
		});
		configCache.set(tempDir.path(), { servers: { formatter }, idleTimeoutMs: undefined });
		const cached = vi.spyOn(configCache, "get");
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const fileA = path.join(tempDir.path(), "a.ts");
		const fileB = path.join(tempDir.path(), "b.ts");
		const batchId = `final-write-failure-${Date.now()}`;
		await writethrough(fileA, "const applied = true;\n", undefined, undefined, {
			id: batchId,
			flush: false,
		});
		vi.spyOn(bun, "write").mockRejectedValueOnce(new Error("ENOSPC"));

		await expect(
			writethrough(fileB, "const failed = true;\n", undefined, undefined, {
				id: batchId,
				flush: true,
			}),
		).rejects.toThrow("ENOSPC");

		expect(formatted).toEqual([fileA]);
		expect(cached).toHaveBeenCalledTimes(1);
		expect(await bun.file(fileA).text()).toBe("const applied = true;\n");
		expect(await bun.file(fileB).exists()).toBe(false);
	});

	it("runs LSP immediately when no batch is provided", async () => {
		const formatted: string[] = [];
		const formatter = createFormatter(async (filePath, content) => {
			formatted.push(filePath);
			return content;
		});
		configCache.set(tempDir.path(), { servers: { formatter }, idleTimeoutMs: undefined });
		const cached = vi.spyOn(configCache, "get");
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		const filePath = path.join(tempDir.path(), "single.ts");
		const result = await writethrough(filePath, "const single = true;\n");

		expect(result.finalContent).toBe("const single = true;\n");
		expect(formatted).toEqual([filePath]);
		expect(cached).toHaveBeenCalledTimes(1);
		expect(await bun.file(filePath).text()).toBe("const single = true;\n");
	});
});

// A privileged user is not constrained by mode bits: a 0o000 file stays both
// writable and readable, so the write would never be denied and the seam under
// test would never engage.
describe.skipIf(process.getuid?.() === 0)("createLspWritethrough batching with a brokered write", () => {
	let tempDir: TempDir;
	let root = "";
	const disposers: Array<() => void> = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-lsp-batch-broker-");
		// The seam hands handlers a symlink-resolved path and `os.tmpdir()` sits
		// under `/var` — itself a link — on macOS, so a lexical fixture root would
		// differ from the brokered path for a reason unrelated to this test.
		root = await fs.realpath(tempDir.path());
		configCache.set(root, { servers: {}, idleTimeoutMs: undefined });
	});

	afterEach(async () => {
		for (const dispose of disposers.splice(0)) dispose();
		vi.restoreAllMocks();
		configCache.clear();
		await fs.chmod(path.join(root, "opaque.ts"), 0o600).catch(() => {});
		tempDir.removeSync();
	});

	it("flushes a batch whose brokered destination cannot be read back", async () => {
		const writethrough = createLspWritethrough(root, { enableFormat: true, enableDiagnostics: true });

		// Denied for writing and for reading at once, which is what a sandbox that
		// hides a path produces: the direct write fails, a privileged helper lands
		// the bytes, and this process still cannot read them back.
		const opaque = path.join(root, "opaque.ts");
		await bun.write(opaque, "const before = true;\n");
		await fs.chmod(opaque, 0o000);

		const brokered: Array<{ dst: string; content: string }> = [];
		disposers.push(
			addFileWriteFallback(async req => {
				brokered.push({ dst: req.dst, content: req.content });
				await fs.chmod(req.dst, 0o600);
				await bun.write(req.dst, req.content);
				await fs.chmod(req.dst, 0o000);
				return true;
			}),
		);

		const sibling = path.join(root, "sibling.ts");
		const batchId = `brokered-${Date.now()}`;
		await writethrough(opaque, "const after = true;\n", undefined, undefined, { id: batchId, flush: false });
		await writethrough(sibling, "const other = true;\n", undefined, undefined, { id: batchId, flush: true });

		expect(brokered).toEqual([{ dst: opaque, content: "const after = true;\n" }]);
		expect(await bun.file(sibling).text()).toBe("const other = true;\n");
		await fs.chmod(opaque, 0o400);
		expect(await bun.file(opaque).text()).toBe("const after = true;\n");
	});
});
