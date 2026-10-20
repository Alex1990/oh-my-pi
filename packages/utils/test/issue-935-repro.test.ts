import { afterEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import * as fs from "node:fs";
import type * as NodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

const fsMock = vi.hoisted(() => ({ failRealpath: false, calls: [] as unknown[][] }));

// Node ESM namespace objects are frozen; replace the binding from a module mock
// instead of `spyOn(fs, "realpathSync")`.
vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof NodeFs>();
	const realpathSync = ((...args: Parameters<typeof actual.realpathSync>) => {
		fsMock.calls.push(args);
		if (fsMock.failRealpath) {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}
		return actual.realpathSync(...args);
	}) as typeof actual.realpathSync;
	return { ...actual, realpathSync };
});

describe("issue #935 path equivalence", () => {
	afterEach(() => {
		fsMock.failRealpath = false;
		fsMock.calls = [];
	});

	it("falls back to the lexical project path when realpath fails", () => {
		const inputPath = path.resolve("/sessions/link-project");
		fsMock.failRealpath = true;

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
		expect(fsMock.calls).toEqual([[inputPath]]);
	});

	it("resolves a missing path through its deepest existing ancestor only when asked", () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-through-missing-"));
		try {
			const real = path.join(temp, "real");
			const link = path.join(temp, "link");
			fs.mkdirSync(real);
			try {
				fs.symlinkSync(real, link, "junction");
			} catch {
				return; // Symlinks unavailable on this host.
			}
			const missing = path.join(link, "sub", "new.ts");
			expect(resolveEquivalentPath(missing)).toBe(missing);
			expect(resolveEquivalentPath(missing, { throughMissing: true })).toBe(
				path.join(fs.realpathSync(real), "sub", "new.ts"),
			);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});
