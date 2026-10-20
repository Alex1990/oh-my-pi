import { afterEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import type * as NodeFsPromisesModule from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerDaemonProjectPresence } from "../../src/launch/presence";

// Node module namespaces are frozen; drive `fs.realpath` through a mock factory.
const fsRealpath = vi.hoisted(() => ({
	override: undefined as undefined | ((input: string) => Promise<string>),
	actual: undefined as undefined | ((input: PathLike) => Promise<string>),
}));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof NodeFsPromisesModule>();
	fsRealpath.actual = actual.realpath as unknown as (input: PathLike) => Promise<string>;
	return {
		...actual,
		realpath: (input: PathLike) =>
			fsRealpath.override ? fsRealpath.override(String(input)) : actual.realpath(input),
	};
});

describe("daemon presence canonicalProjectDir EISDIR fallback", () => {
	const originalRealpath = (input: PathLike): Promise<string> =>
		(fsRealpath.actual ?? fs.realpath)(input) as Promise<string>;

	afterEach(() => {
		fsRealpath.override = undefined;
		vi.restoreAllMocks();
	});

	it("falls back to the resolved path when realpath throws EISDIR", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eisdir-fallback-"));
		const runtimeDir = path.join(projectDir, "runtime");
		const resolvedProjectDir = path.resolve(projectDir);
		let realpathCalls = 0;

		fsRealpath.override = async p => {
			if (path.resolve(p) === resolvedProjectDir) {
				realpathCalls++;
				const err = new Error("EISDIR: illegal operation on a directory") as NodeJS.ErrnoException;
				err.code = "EISDIR";
				err.errno = -21;
				err.syscall = "lstat";
				err.path = `R:${path.sep}`;
				throw err;
			}
			return originalRealpath(p);
		};

		try {
			const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
			expect(typeof presence.close).toBe("function");
			expect(realpathCalls).toBe(1);

			const clientsDir = path.join(runtimeDir, "clients");
			const entries = await fs.readdir(clientsDir);
			expect(entries).toHaveLength(1);

			await presence.close();
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
