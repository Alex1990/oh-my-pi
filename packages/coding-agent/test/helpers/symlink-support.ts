import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let cached: Promise<boolean> | undefined;

/**
 * Whether this account may create symlinks.
 *
 * Windows needs Developer Mode or elevation for `fs.symlink`; tests that plant
 * links to verify containment must skip rather than fail when it is denied.
 */
export function canCreateSymlink(): Promise<boolean> {
	cached ??= (async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-symlink-probe-"));
		try {
			await fs.symlink(dir, path.join(dir, "link"), "dir");
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
			throw error;
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	})();
	return cached;
}
