import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { nodeSourceFlags } from "../src/subprocess/worker-client";

interface CacheProbeResult {
	modules: number;
	bytes: number;
	rss: number;
	heapUsed: number;
	paths: string[];
	terminalRows?: string[];
}

const fixture = (name: string): string => path.resolve(import.meta.dirname, "fixtures", name);

async function runProbe(childPath: string): Promise<CacheProbeResult> {
	const proc = bun.spawn([process.execPath, ...nodeSourceFlags(), childPath], {
		cwd: path.resolve(import.meta.dirname, "../.."),
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as CacheProbeResult;
}

describe("launch vterm runtime ownership", () => {
	test("cache detector observes the direct vterm positive control", async () => {
		const result = await runProbe(fixture("xterm-cache-positive-control.ts"));
		expect(result.modules, JSON.stringify(result)).toBeGreaterThan(0);
		expect(result.bytes, JSON.stringify(result)).toBeGreaterThan(0);
	});

	test("normal main startup evaluates no vterm module", async () => {
		const result = await runProbe(fixture("xterm-cache-main-probe.ts"));
		expect(result.modules, JSON.stringify(result)).toBe(0);
	});

	test("static wait import evaluates no vterm module", async () => {
		const result = await runProbe(fixture("xterm-cache-wait-probe.ts"));
		expect(result.modules, JSON.stringify(result)).toBe(0);
	});

	test("legacy replay evaluates vterm outside the client process", async () => {
		const result = await runProbe(fixture("xterm-cache-legacy-replay-probe.ts"));
		expect(result.terminalRows).toEqual(["\x1b[0m\x1b[1;38;5;2mready"]);
		expect(result.modules, JSON.stringify(result)).toBe(0);
		expect(result.bytes, JSON.stringify(result)).toBe(0);
	});

	test("broker import owns the vterm runtime", async () => {
		const result = await runProbe(fixture("xterm-cache-broker-probe.ts"));
		expect(result.modules, JSON.stringify(result)).toBeGreaterThan(0);
		expect(result.bytes, JSON.stringify(result)).toBeGreaterThan(0);
	});
});
