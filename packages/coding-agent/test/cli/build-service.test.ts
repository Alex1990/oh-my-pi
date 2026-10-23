import { afterEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import {
	type BuildHost,
	checksumFor,
	fetchBuild,
	isMuslLinuxForTest,
	parseRelease,
	releaseApiBase,
	releaseRepo,
	resolveBuildHost,
} from "@oh-my-pi/pi-coding-agent/cli/build-service";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { APP_NAME } from "@oh-my-pi/pi-utils";

const fileName = "omp-darwin-arm64";
const sha = (text: string) => bun.SHA256.hash(text, "hex");

function assets(): Array<Record<string, unknown>> {
	return [
		{
			name: fileName,
			size: 205_765_664,
			browser_download_url: `https://github.com/o/r/releases/download/v18.8.9/${fileName}`,
		},
		{
			name: "cli.js",
			size: 12_345,
			browser_download_url: "https://github.com/o/r/releases/download/v18.8.9/cli.js",
		},
		{
			name: "SHA256SUMS.txt",
			size: 200,
			browser_download_url: "https://github.com/o/r/releases/download/v18.8.9/SHA256SUMS.txt",
		},
	];
}

/** A well-formed GitHub release, with `overrides` merged over the top level. */
function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { tag_name: "v18.8.9", draft: false, prerelease: false, assets: assets(), ...overrides };
}

const sums = `${sha("new")}  ${fileName}\n${sha("cli")}  cli.js\n`;

describe("release answers", () => {
	it("keeps the version, tag, asset size, checksum, and download URL", () => {
		expect(parseRelease(release(), fileName, sums)).toEqual({
			version: "18.8.9",
			tag: "v18.8.9",
			file: { name: fileName, size: 205_765_664, sha256: sha("new") },
			download: `https://github.com/o/r/releases/download/v18.8.9/${fileName}`,
		});
	});

	it("rejects releases that cannot be installed safely", () => {
		expect(() => parseRelease(release({ tag_name: "latest" }), fileName, sums)).toThrow("no valid tag");
		expect(() => parseRelease(release({ draft: true }), fileName, sums)).toThrow("draft");
		expect(() => parseRelease(release({ assets: [] }), fileName, sums)).toThrow(`no ${fileName} asset`);
		expect(() =>
			parseRelease(release({ assets: assets().filter(asset => asset.name !== "SHA256SUMS.txt") }), fileName, sums),
		).toThrow("no SHA256SUMS.txt asset");
		expect(() => parseRelease(release(), fileName, "")).toThrow(`SHA256SUMS.txt has no entry for ${fileName}`);
		expect(() =>
			parseRelease(
				release({
					assets: [{ name: fileName, size: 1, browser_download_url: `http://github.com/${fileName}` }],
				}),
				fileName,
				sums,
			),
		).toThrow("no HTTPS download");
	});

	it("accepts binary-mode checksum lines and never cross-matches a different asset", () => {
		expect(checksumFor(`${sha("new").toUpperCase()} *${fileName}\n`, fileName)).toBe(sha("new"));
		expect(checksumFor(`${sha("other")}  omp-darwin-x64\n`, fileName)).toBeUndefined();
	});
});

describe("release targets", () => {
	it("maps platform, architecture, and libc to the release asset name", () => {
		expect(resolveBuildHost("darwin", "arm64", false)).toEqual({ fileName: "omp-darwin-arm64" });
		expect(resolveBuildHost("linux", "x64", true)).toEqual({ fileName: "omp-linux-musl-x64" });
		expect(resolveBuildHost("linux", "arm64", false)).toEqual({ fileName: "omp-linux-arm64" });
		expect(resolveBuildHost("win32", "x64", false)).toEqual({ fileName: "omp-windows-x64.cmd" });
	});

	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("fetchBuild", () => {
	const host: BuildHost = { fileName };
	const previousApi = process.env.OMP_RELEASE_API;
	const previousRepo = process.env.OMP_RELEASE_REPO;

	afterEach(() => {
		if (previousApi === undefined) delete process.env.OMP_RELEASE_API;
		else process.env.OMP_RELEASE_API = previousApi;
		if (previousRepo === undefined) delete process.env.OMP_RELEASE_REPO;
		else process.env.OMP_RELEASE_REPO = previousRepo;
	});

	it("asks the configured API for the newest stable release", async () => {
		process.env.OMP_RELEASE_API = "https://api.test/repos/o/r/";
		const requests: Array<string> = [];
		const build = await fetchBuild(
			{ channel: "stable" },
			{
				host,
				fetchImpl: async input => {
					const url = String(input);
					requests.push(url);
					return url.endsWith("/SHA256SUMS.txt") ? new Response(sums) : Response.json(release());
				},
			},
		);

		expect(requests).toEqual([
			"https://api.test/repos/o/r/releases/latest",
			"https://github.com/o/r/releases/download/v18.8.9/SHA256SUMS.txt",
		]);
		expect(build.version).toBe("18.8.9");
	});

	it("asks for one exact version by tag", async () => {
		process.env.OMP_RELEASE_API = "https://api.test/repos/o/r";
		const requests: string[] = [];
		await fetchBuild(
			{ version: "18.8.9" },
			{
				host,
				fetchImpl: async input => {
					const url = String(input);
					requests.push(url);
					return url.endsWith("/SHA256SUMS.txt") ? new Response(sums) : Response.json(release());
				},
			},
		);
		expect(requests[0]).toBe("https://api.test/repos/o/r/releases/tags/v18.8.9");
	});

	it("takes the newest prerelease on the canary channel, skipping drafts", async () => {
		process.env.OMP_RELEASE_API = "https://api.test/repos/o/r";
		let listUrl = "";
		const build = await fetchBuild(
			{ channel: "canary" },
			{
				host,
				fetchImpl: async input => {
					const url = String(input);
					if (url.endsWith("/SHA256SUMS.txt")) return new Response(sums);
					listUrl = url;
					return Response.json([
						release({ tag_name: "v19.0.0" }),
						release({ tag_name: "v19.1.0-canary.2", prerelease: true }),
						release({ tag_name: "v19.2.0-canary.3", prerelease: true, draft: true }),
					]);
				},
			},
		);
		expect(listUrl).toBe("https://api.test/repos/o/r/releases?per_page=30");
		expect(build.version).toBe("19.1.0-canary.2");
	});

	it("reports a missing release and a missing canary", async () => {
		process.env.OMP_RELEASE_API = "https://api.test/repos/o/r";
		await expect(
			fetchBuild({ channel: "stable" }, { host, fetchImpl: async () => new Response("", { status: 404 }) }),
		).rejects.toThrow("No stable release is published.");
		await expect(
			fetchBuild({ channel: "canary" }, { host, fetchImpl: async () => Response.json([]) }),
		).rejects.toThrow(`No canary release is published. Try \`${APP_NAME} update --stable\`.`);
	});

	it("defaults to the release repository", () => {
		delete process.env.OMP_RELEASE_API;
		delete process.env.OMP_RELEASE_REPO;
		expect(releaseRepo()).toBe("Alex1990/oh-your-pi");
		expect(releaseApiBase()).toBe("https://api.github.com/repos/Alex1990/oh-your-pi");
	});
});
