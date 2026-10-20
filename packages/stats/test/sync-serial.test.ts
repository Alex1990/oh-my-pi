import { afterEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const workerProbe = vi.hoisted(() => ({ constructions: 0, error: null as Error | null }));
vi.mock("@oh-my-pi/pi-utils/worker", () => ({
	Worker: class {
		constructor() {
			workerProbe.constructions++;
			if (workerProbe.error) throw workerProbe.error;
		}
	},
}));

installStatsTestIsolation("@pi-stats-sync-serial-");

afterEach(() => {
	vi.restoreAllMocks();
	workerProbe.constructions = 0;
	workerProbe.error = null;
});

async function writeSessionFile(options?: { includeCost?: boolean }): Promise<void> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const includeCost = options?.includeCost ?? true;
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				...(includeCost ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}),
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await bun.write(sessionFile, `${JSON.stringify(assistant)}\n`);
}

describe("stats sync serial mode", () => {
	it("honors workers: 1 without spawning a worker", async () => {
		await writeSessionFile();
		const workerSpy = workerProbe;

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy.constructions).toBe(0);
	});

	it("skips gc compress scratch copies but keeps transcripts in other dot directories", async () => {
		await writeSessionFile();
		const folder = path.join(getSessionsDir(), "--tmp--sync-serial");
		const scratch = path.join(folder, ".omp-gc-compress-a1b2c3");
		const hidden = path.join(folder, "session", ".runs");
		await fs.mkdir(scratch);
		await fs.mkdir(hidden, { recursive: true });
		await fs.copyFile(path.join(folder, "session.jsonl"), path.join(scratch, "session.jsonl"));
		await fs.copyFile(path.join(folder, "session.jsonl"), path.join(hidden, "child.jsonl"));

		const synced = await syncAllSessions({ workers: 1 });

		expect(synced.files).toBe(2);
	});

	it("syncs legacy session usage without a cost breakdown", async () => {
		await writeSessionFile({ includeCost: false });

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced).toEqual({ processed: 1, files: 1 });
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeGreaterThan(0);
	});

	it("uses the serial parser by default on macOS", async () => {
		await writeSessionFile();
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = workerProbe;

		const synced = await syncAllSessions();
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy.constructions).toBe(0);
	});

	it("spawns no worker when every transcript is unchanged", async () => {
		await writeSessionFile();
		await syncAllSessions({ workers: 1 });
		const workerSpy = workerProbe;

		const synced = await syncAllSessions({ workers: 2 });

		expect(synced).toEqual({ processed: 0, files: 0 });
		expect(workerSpy.constructions).toBe(0);
	});

	it("parses a few already-tracked transcripts inline by default", async () => {
		await writeSessionFile();
		await syncAllSessions({ workers: 1 });
		const sessionFile = path.join(getSessionsDir(), "--tmp--sync-serial", "session.jsonl");
		await fs.appendFile(sessionFile, "\n");
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		const workerSpy = workerProbe;

		await syncAllSessions({ files: [sessionFile] });

		expect(workerSpy.constructions).toBe(0);
	});

	it("spawns a worker pool when callers explicitly request workers: 2 with a single file", async () => {
		await writeSessionFile();
		const workerError = new Error("worker probe");
		workerProbe.error = workerError;

		await expect(syncAllSessions({ workers: 2 })).rejects.toBe(workerError);
		expect(workerProbe.constructions).toBeGreaterThan(0);
	});
});
