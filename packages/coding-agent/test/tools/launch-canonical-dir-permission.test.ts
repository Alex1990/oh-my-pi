import { afterEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import type * as NodeFsPromisesModule from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalProjectDir } from "../../src/launch/paths";

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

describe("canonicalProjectDir permission fallback", () => {
	const originalRealpath = (input: PathLike): Promise<string> =>
		(fsRealpath.actual ?? fs.realpath)(input) as Promise<string>;

	afterEach(() => {
		fsRealpath.override = undefined;
		vi.restoreAllMocks();
	});

	function throwErrno(code: string, errno: number): never {
		const err = new Error(`${code}: permission denied`) as NodeJS.ErrnoException;
		err.code = code;
		err.errno = errno;
		err.syscall = "realpath";
		throw err;
	}

	for (const [code, errno] of [
		["EPERM", -1],
		["EACCES", -13],
	] as const) {
		it(`resolves the normalized absolute path when realpath throws ${code}`, async () => {
			const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-${code.toLowerCase()}-fallback-`));
			const resolvedProjectDir = path.resolve(projectDir);

			fsRealpath.override = async p => {
				if (path.resolve(p) === resolvedProjectDir) {
					throwErrno(code, errno);
				}
				return originalRealpath(p);
			};

			try {
				await expect(canonicalProjectDir(projectDir)).resolves.toBe(resolvedProjectDir);
			} finally {
				await fs.rm(projectDir, { recursive: true, force: true });
			}
		});
	}

	// Creating symlinks on Windows requires Developer Mode or an elevated token.
	it.skipIf(process.platform === "win32")("still resolves symlinks to their real target when realpath succeeds", async () => {
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-canonical-target-"));
		const linkDir = path.join(os.tmpdir(), `omp-canonical-link-${Date.now()}-${process.pid}`);
		await fs.symlink(targetDir, linkDir, "dir");

		try {
			await expect(canonicalProjectDir(linkDir)).resolves.toBe(await fs.realpath(targetDir));
		} finally {
			await fs.rm(linkDir, { force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("rethrows realpath errors that are not missing-path or permission errors", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eloop-rethrow-"));
		const resolvedProjectDir = path.resolve(projectDir);

		fsRealpath.override = async p => {
			if (path.resolve(p) === resolvedProjectDir) {
				throwErrno("ELOOP", -62);
			}
			return originalRealpath(p);
		};

		try {
			await expect(canonicalProjectDir(projectDir)).rejects.toMatchObject({ code: "ELOOP" });
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
