import { afterEach, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Subprocess } from "@oh-my-pi/pi-utils/node-runtime";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { Archive } from "@oh-my-pi/pi-utils/node-archive";
import { plugin } from "@oh-my-pi/pi-utils/module-hooks";

const tempDirs: string[] = [];
const children: Array<Subprocess<"ignore", "pipe", "pipe">> = [];
const clientFiles = {
	"index.html": '<!doctype html><html><body><script type="module" src="/index.js"></script></body></html>',
	"index.js": 'document.documentElement.dataset.loaded = "true";',
	"styles.css": "body { color: blue; }",
	"favicon.ico": await bun.file(path.resolve(import.meta.dirname, "../src/client/favicon.ico")).bytes(),
};

async function startEmbeddedDashboard(): Promise<{ url: string; tmpDir: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-embedded-"));
	tempDirs.push(root);
	const tmpDir = path.join(root, "tmp");
	await fs.mkdir(tmpDir);
	const archive = Buffer.from(bun.gzipSync(await new Archive(clientFiles).bytes())).toString("base64");
	const preload = path.join(root, "preload.ts");
	const entrypoint = path.join(root, "server.ts");
	// Keep the embedded-archive loader and directory overrides in a child process.
	await bun.write(
		preload,
		`import { plugin } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../../../packages/utils/src/module-hooks.ts")).href)};
plugin({
	name: "embedded-stats-client-fixture",
	setup(build) {
		build.onLoad({ filter: /embedded-client\\.generated\\.txt$/ }, () => ({
			exports: { default: ${JSON.stringify(archive)} }, loader: "object",
		}));
	},
});`,
	);
	await bun.write(
		entrypoint,
		`import { startServer } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../src/server.ts")).href)};
const server = await startServer(0);
process.stdout.write(JSON.stringify({ url: "http://" + server.hostname + ":" + server.port }));`,
	);
	const loader = pathToFileURL(path.resolve(import.meta.dirname, "../../../scripts/node-runtime-loader.mjs")).href;
	const child = bun.spawn(
		[
			process.execPath,
			"--experimental-transform-types",
			"--import",
			loader,
			"--import",
			pathToFileURL(preload).href,
			entrypoint,
		],
		{
		cwd: root,
		env: {
			...process.env,
			HOME: root,
			USERPROFILE: root,
			TMPDIR: tmpDir,
			TMP: tmpDir,
			TEMP: tmpDir,
			PI_CONFIG_DIR: ".omp",
			PI_CODING_AGENT_DIR: path.join(root, ".omp", "agent"),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_CACHE_HOME: path.join(root, "cache"),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(child);
	const reader = child.stdout.getReader();
	const ready = await reader.read();
	reader.releaseLock();
	if (ready.done) {
		throw new Error(`Dashboard failed to start: ${await new Response(child.stderr).text()}`);
	}
	const { url }: { url: string } = JSON.parse(new TextDecoder().decode(ready.value));
	return { url, tmpDir };
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill();
		await child.exited;
	}
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

test("embedded dashboard serves its assets and SPA routes after temporary files are removed", async () => {
	const { url, tmpDir } = await startEmbeddedDashboard();
	const initial = await fetch(url);
	expect(initial.status).toBe(200);
	expect(await initial.text()).toBe(clientFiles["index.html"]);

	// Model OS cleanup while the server remains alive, without touching the real TMPDIR.
	await fs.rm(tmpDir, { recursive: true, force: true });

	const requests = [
		{ route: "/", file: "index.html", mime: "text/html" },
		{ route: "/index.js", file: "index.js", mime: "text/javascript" },
		{ route: "/styles.css", file: "styles.css", mime: "text/css" },
		{ route: "/favicon.ico", file: "favicon.ico", mime: "image/x-icon" },
		{ route: "/traces/session", file: "index.html", mime: "text/html" },
	] as const;
	await Promise.all(
		requests.map(async ({ route, file, mime }) => {
			const response = await fetch(url + route);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toStartWith(mime);
			const expected = clientFiles[file];
			if (typeof expected === "string") {
				expect(await response.text()).toBe(expected);
			} else {
				expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
			}
		}),
	);
});
