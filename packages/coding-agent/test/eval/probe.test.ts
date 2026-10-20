// Integration test: runBoundedProbe spawns and kills a real subprocess, so the
// timeout/abort teardown is inherently wall-clock bound. Fake timers cannot
// advance a child process's execution or resolve its `exited` promise, so the
// real-timer exception in ts-no-test-timers applies here.
import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCandidates, runBoundedProbe } from "../../src/eval/probe";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

// A cross-platform "hangs forever" command: re-invoke the running Bun to sleep.
const nodeExecutable = process.execPath;
const HANG = [nodeExecutable, "-e", "setTimeout(() => {}, 60_000)"];
const IGNORE_TERM = [nodeExecutable, "-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000)'];
const baseEnv = (): Record<string, string | undefined> => ({ ...process.env });

describe("runBoundedProbe", () => {
	test("a hung probe is bounded by its timeout instead of hanging (regression: #9466)", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, { cwd: process.cwd(), env: baseEnv(), timeoutMs: 300 });
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("force-kills a probe that ignores SIGTERM when its timeout expires", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(IGNORE_TERM, {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 300,
		});
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("kills descendants spawned by an interpreter shim", async () => {
		const pidFile = join(tmpdir(), `omp-probe-grandchild-${process.pid}-${Date.now()}.pid`);
		let grandchildPid: number | undefined;
		const wrapper = [
			nodeExecutable,
			"-e",
			`const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: ["ignore", "ignore", "ignore"] }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); child.on("exit", () => {});`,
		];
		try {
			const result = await runBoundedProbe(wrapper, {
				cwd: process.cwd(),
				env: baseEnv(),
				timeoutMs: 1_000,
			});
			expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
			grandchildPid = Number(await bun.file(pidFile).text());
			const deadline = Date.now() + 2_000;
			while (Date.now() < deadline) {
				try {
					process.kill(grandchildPid, 0);
					await bun.sleep(25);
				} catch {
					break;
				}
			}
			expect(() => process.kill(grandchildPid!, 0)).toThrow();
		} finally {
			if (grandchildPid !== undefined) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {
					// Expected when the process-tree teardown succeeded.
				}
			}
			await rm(pidFile, { force: true });
		}
	});

	test("an already-aborted signal short-circuits without spawning", async () => {
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ exitCode: null, timedOut: false, aborted: true });
	});

	test("an in-flight probe is killed when its signal aborts", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.timeout(100),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("a fast probe reports its real exit code", async () => {
		const ok = await runBoundedProbe([nodeExecutable, "-e", "process.exit(0)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(ok).toEqual({ exitCode: 0, timedOut: false, aborted: false });

		const failing = await runBoundedProbe([nodeExecutable, "-e", "process.exit(3)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(failing).toEqual({ exitCode: 3, timedOut: false, aborted: false });
	});
});

describe("probeCandidates", () => {
	test("shares one discovery deadline across hung candidates instead of paying it per candidate", async () => {
		// Wall-clock overhead for starting and killing one probe is platform-bound
		// (Node process startup dominates on Windows). Measure it once instead of
		// hard-coding a slice, then assert that three candidates cost far less
		// than three independent budgets would.
		const singleStart = Date.now();
		await probeCandidates([{ command: HANG, env: baseEnv(), label: "baseline" }], {
			cwd: process.cwd(),
			timeoutMs: 300,
		});
		const singleElapsed = Date.now() - singleStart;

		const start = Date.now();
		const result = await probeCandidates(
			[
				{ command: HANG, env: baseEnv(), label: "cand-a" },
				{ command: HANG, env: baseEnv(), label: "cand-b" },
				{ command: HANG, env: baseEnv(), label: "cand-c" },
			],
			{ cwd: process.cwd(), timeoutMs: 300 },
		);
		const elapsed = Date.now() - start;
		expect(result).toEqual({ ok: false, aborted: false, failures: expect.any(Array) });
		// Paying each candidate its own 300ms budget costs about `3 × single`.
		// Sharing one budget keeps three candidates under that, plus only the
		// extra per-candidate spawn overhead.
		expect(elapsed).toBeLessThan(singleElapsed * 2.5);
	});

	test("returns the first candidate that exits 0 and skips the rest", async () => {
		const result = await probeCandidates(
			[
				{ command: [nodeExecutable, "-e", "process.exit(1)"], env: baseEnv(), label: "bad" },
				{ command: [nodeExecutable, "-e", "process.exit(0)"], env: baseEnv(), label: "good" },
				{ command: HANG, env: baseEnv(), label: "would-hang" },
			],
			{ cwd: process.cwd(), timeoutMs: 5_000 },
		);
		expect(result).toEqual({ ok: true, index: 1 });
	});
});
