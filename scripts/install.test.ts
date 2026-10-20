import { afterEach, describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { serve } from "@oh-my-pi/pi-utils/node-serve";

// install.sh binary mode against a fake GitHub release. The host is faked as
// musl Linux x64 by shadowing uname/ldd via PATH; MSYS sh on Windows prepends
// /usr/bin, so the stubs never win there.

const repoRoot = path.join(import.meta.dirname, "..");
const BINARY = '#!/bin/sh\necho "omp/1.0.0"\n';
const CLI_JS = 'console.log("omp/1.0.0");\n';
const ASSET = "omp-linux-musl-x64";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function sha256(text: string): string {
	return new bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * A fake GitHub release answering `SHA256SUMS.txt`, the host asset, and
 * `cli.js`. Both `latest/download` and `download/<tag>` layouts are served, so
 * the tests can assert which one the installer chose.
 */
async function startRelease(
	options: { binarySha?: string; cliSha?: string } = {},
): Promise<{ base: string; requests: string[] }> {
	const binarySha = options.binarySha ?? sha256(BINARY);
	const cliSha = options.cliSha ?? sha256(CLI_JS);
	const requests: string[] = [];
	const server = await serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push(url.pathname);
			if (url.pathname.endsWith("/SHA256SUMS.txt")) {
				return new Response(`${binarySha}  ${ASSET}\n${cliSha}  cli.js\n`);
			}
			if (url.pathname.endsWith(`/${ASSET}`)) return new Response(BINARY);
			if (url.pathname.endsWith("/cli.js")) return new Response(CLI_JS);
			return new Response("no such asset", { status: 404 });
		},
	});
	cleanups.push(() => server.stop(true));
	return { base: `${server.url.origin}/releases`, requests };
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function runInstall(
	releaseBase: string,
	args: string[],
): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	installDir: string;
}> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-install-"));
	cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
	const binDir = path.join(dir, "bin");
	const installDir = path.join(dir, "install");
	await writeExecutable(path.join(binDir, "uname"), '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
	await writeExecutable(path.join(binDir, "ldd"), "#!/bin/sh\necho 'musl libc (x86_64)'\n");
	const proc = bun.spawn(["sh", "scripts/install.sh", ...args], {
		cwd: repoRoot,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			HOME: dir,
			PI_INSTALL_DIR: installDir,
			OMP_RELEASE_BASE: releaseBase,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr, installDir };
}

describe.skipIf(process.platform === "win32")("install.sh binary mode", () => {
	test("installs the latest release's asset, verified against SHA256SUMS.txt", async () => {
		const release = await startRelease();
		const result = await runInstall(release.base, ["--binary"]);

		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(release.requests).toContain("/releases/latest/download/SHA256SUMS.txt");
		expect(release.requests).toContain(`/releases/latest/download/${ASSET}`);
		expect(release.requests).toContain("/releases/latest/download/cli.js");
		expect(result.stdout).toContain("Using the latest release");
		expect((await fs.readdir(result.installDir)).sort()).toEqual(["cli.js", "omp"]);
		expect(await bun.file(path.join(result.installDir, "omp")).text()).toBe(BINARY);
		expect(await bun.file(path.join(result.installDir, "cli.js")).text()).toBe(CLI_JS);
	});

	test("refuses a download whose sha256 differs from SHA256SUMS.txt", async () => {
		const release = await startRelease({ binarySha: sha256("something else") });
		const result = await runInstall(release.base, ["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain(`Checksum mismatch for ${ASSET}`);
		expect(await fs.readdir(result.installDir)).toEqual([]);
	});

	test("refuses a cli.js whose sha256 differs from SHA256SUMS.txt", async () => {
		const release = await startRelease({ cliSha: sha256("another bundle") });
		const result = await runInstall(release.base, ["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("Checksum mismatch for cli.js");
		expect(await fs.readdir(result.installDir)).toEqual([]);
	});

	test("--ref resolves the tagged release and rejects non-tag refs", async () => {
		const release = await startRelease();
		const tagged = await runInstall(release.base, ["--binary", "--ref", "v1.0.0"]);
		expect(tagged.exitCode, tagged.stdout + tagged.stderr).toBe(0);
		expect(release.requests).toContain("/releases/download/v1.0.0/SHA256SUMS.txt");
		expect(release.requests).toContain(`/releases/download/v1.0.0/${ASSET}`);
		expect(tagged.stdout).toContain("Using version: 1.0.0");

		const branch = await runInstall(release.base, ["--binary", "--ref", "main"]);
		expect(branch.exitCode).toBe(1);
		expect(branch.stdout).toContain("use --source with --ref");
		expect(release.requests).toHaveLength(3);
	});
});
