import { afterEach, describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { serve } from "@oh-my-pi/pi-utils/node-serve";

// install.sh binary mode against a fake build service. The host is faked as
// musl Linux x64 by shadowing uname/ldd via PATH; MSYS sh on Windows prepends
// /usr/bin, so the stubs never win there.

const repoRoot = path.join(import.meta.dirname, "..");
const BINARY = '#!/bin/sh\necho "omp/1.0.0"\n';
const CLI_JS = 'console.log("omp/1.0.0");\n';
const BUILDS = "/d/omp/20261010-171748-fa5ff4a";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function sha256(text: string): string {
	return new bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * A build service answering every update check with version 1.0.0 of
 * `omp-linux-musl-x64`, whose `file` object carries `fileSha256`, plus the
 * shared `cli.js` bundle in `build.files[]`. Every other sha256 in the answer
 * (other targets in `build.files[]`, the patch, a JSON snippet in the notes) is
 * wrong, and the `download` URL holds a `\u0026` escape the way Go's encoder
 * writes presigned URLs.
 */
function startService(fileSha256: string, cliSha256 = sha256(CLI_JS)): { url: string; requests: string[] } {
	const requests: string[] = [];
	const server = serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			requests.push(url.pathname + url.search);
			if (url.pathname === "/dl/omp-linux-musl-x64") {
				return url.searchParams.get("b") === "2"
					? new Response(BINARY)
					: new Response("bad query", { status: 403 });
			}
			if (url.pathname === `${BUILDS}/cli.js`) return new Response(CLI_JS);
			if (url.pathname.startsWith("/d/omp/")) return new Response("no such file", { status: 404 });
			if (!url.pathname.startsWith("/api/products/omp/"))
				return Response.json({ error: "no_build" }, { status: 404 });
			const decoy = "0".repeat(64);
			const answer = {
				build: {
					id: "20261010-171748-fa5ff4a",
					product: "omp",
					version: "1.0.0",
					channel: "stable",
					notes: `Answers look like {"file":{"sha256":"${decoy}"},"version":"9.9.9"}`,
					files: [
						{
							name: "omp-linux-x64",
							platform: "linux",
							arch: "x86_64",
							sha256: decoy,
						},
						{
							name: "omp-linux-musl-x64",
							platform: "linux-musl",
							arch: "x86_64",
							sha256: decoy,
						},
						{
							name: "cli.js",
							platform: "any",
							arch: "any",
							sha256: cliSha256,
						},
					],
				},
				file: {
					name: "omp-linux-musl-x64",
					platform: "linux-musl",
					arch: "x86_64",
					kind: "archive",
					size: BINARY.length,
					sha256: fileSha256,
					url: "/d/omp/20261010-171748-fa5ff4a/omp-linux-musl-x64",
				},
				download: `${server.url.origin}/dl/omp-linux-musl-x64?a=1&b=2`,
				patch: {
					format: "file",
					from: "20261009-000000-0000000",
					from_sha256: decoy,
					size: 1,
					sha256: "f".repeat(64),
					url: `${server.url.origin}/patch`,
				},
			};
			return new Response(JSON.stringify(answer).replaceAll("&", "\\u0026"), {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	cleanups.push(() => server.stop(true));
	// Trailing slashes on PI_BUILD_URL are trimmed.
	return { url: `${server.url.origin}/`, requests };
}

async function writeExecutable(file: string, content: string): Promise<void> {
	await bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function runInstall(
	buildUrl: string,
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
			PI_BUILD_URL: buildUrl,
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
	test("installs the host target's build, verified against the answer's file sha256", async () => {
		const service = startService(sha256(BINARY));
		const result = await runInstall(service.url, ["--binary"]);

		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/latest/linux-musl-x86_64?channel=stable");
		expect(result.stdout).toContain("Using version: 1.0.0");
		expect((await fs.readdir(result.installDir)).sort()).toEqual(["cli.js", "omp"]);
		expect(await bun.file(path.join(result.installDir, "omp")).text()).toBe(BINARY);
		expect(await bun.file(path.join(result.installDir, "cli.js")).text()).toBe(CLI_JS);
	});

	test("refuses a download whose sha256 differs from the answer's file object", async () => {
		const service = startService(sha256("something else"));
		const result = await runInstall(service.url, ["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("Checksum mismatch for omp-linux-musl-x64");
		expect(await fs.readdir(result.installDir)).toEqual([]);
	});

	test("refuses a cli.js whose sha256 differs from the answer's build file entry", async () => {
		const service = startService(sha256(BINARY), sha256("another bundle"));
		const result = await runInstall(service.url, ["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("Checksum mismatch for cli.js");
		expect(await fs.readdir(result.installDir)).toEqual([]);
	});

	test("--ref resolves a release tag through the versions endpoint and rejects other refs", async () => {
		const service = startService(sha256(BINARY));
		const tagged = await runInstall(service.url, ["--binary", "--ref", "v1.0.0"]);
		expect(tagged.exitCode, tagged.stdout + tagged.stderr).toBe(0);
		expect(service.requests[0]).toBe("/api/products/omp/versions/1.0.0/linux-musl-x86_64");

		const branch = await runInstall(service.url, ["--binary", "--ref", "main"]);
		expect(branch.exitCode).toBe(1);
		expect(branch.stdout).toContain("use --source with --ref");
		expect(service.requests).toHaveLength(2);
	});
});
