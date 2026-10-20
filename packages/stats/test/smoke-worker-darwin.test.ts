import { afterEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import { smokeTestSyncWorker } from "@oh-my-pi/omp-stats/aggregator";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const workerProbe = vi.hoisted(() => ({ constructions: 0 }));
vi.mock("@oh-my-pi/pi-utils/worker", () => ({
	Worker: class {
		constructor() {
			workerProbe.constructions++;
			throw new Error("worker should not be created on darwin");
		}
	},
}));

installStatsTestIsolation("@pi-stats-smoke-darwin-");

afterEach(() => {
	vi.restoreAllMocks();
	workerProbe.constructions = 0;
});

describe("smokeTestSyncWorker", () => {
	it("skips the worker spawn on darwin so omp --smoke-test stays off the macOS abort surface", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

		await expect(smokeTestSyncWorker()).resolves.toBeUndefined();
		expect(workerProbe.constructions).toBe(0);
	});
});
