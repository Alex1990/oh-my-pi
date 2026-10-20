import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import type * as NodeFs from "node:fs";
import * as logger from "@oh-my-pi/pi-utils/logger";

const fsMock = vi.hoisted(() => ({ writes: [] as string[] }));

// Node's ESM namespace objects are frozen, so the startup markers are captured
// by wrapping the real binding rather than spying on the namespace export.
vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof NodeFs>();
	const writeSync = ((_fd: number, data: string) => {
		fsMock.writes.push(String(data));
		return String(data).length;
	}) as typeof actual.writeSync;
	return { ...actual, writeSync };
});

/** Run `fn` with PI_DEBUG_STARTUP set, capturing `[startup]` stderr markers. */
function withMarkerCapture<T>(fn: () => T): { result: T; markers: string[] } {
	const prev = process.env.PI_DEBUG_STARTUP;
	process.env.PI_DEBUG_STARTUP = "1";
	fsMock.writes = [];
	let result: T;
	try {
		result = fn();
	} finally {
		if (prev === undefined) {
			delete process.env.PI_DEBUG_STARTUP;
		} else {
			process.env.PI_DEBUG_STARTUP = prev;
		}
	}
	const markers = fsMock.writes.filter(write => write.startsWith("[startup]")).map(write => write.trimEnd());
	return { result, markers };
}

describe("PI_DEBUG_STARTUP streaming markers", () => {
	// Contract: with PI_DEBUG_STARTUP set, every logger.time phase leaves a
	// synchronous `:start` marker before running — so a phase that hangs the
	// process forever is still identified by the last marker on stderr. This
	// must work without startTiming() (markers are independent of PI_TIMING).
	it("brackets a phase with start/done markers", () => {
		const { result, markers } = withMarkerCapture(() => logger.time("phase:test", () => 42));
		expect(result).toBe(42);
		expect(markers).toEqual(["[startup] phase:test:start", "[startup] phase:test:done"]);
	});

	it("marks a throwing phase as failed and rethrows", () => {
		const { markers } = withMarkerCapture(() => {
			expect(() =>
				logger.time("phase:boom", () => {
					throw new Error("boom");
				}),
			).toThrow("boom");
		});
		expect(markers).toEqual(["[startup] phase:boom:start", "[startup] phase:boom:fail"]);
	});

	it("emits a single marker for point spans", () => {
		const { markers } = withMarkerCapture(() => logger.time("phase:point"));
		expect(markers).toEqual(["[startup] phase:point"]);
	});

	it("emits nothing when PI_DEBUG_STARTUP is unset", () => {
		const prev = process.env.PI_DEBUG_STARTUP;
		delete process.env.PI_DEBUG_STARTUP;
		fsMock.writes = [];
		try {
			expect(logger.time("phase:silent", () => "ok")).toBe("ok");
		} finally {
			if (prev !== undefined) process.env.PI_DEBUG_STARTUP = prev;
		}
		expect(fsMock.writes.filter(write => write.startsWith("[startup]"))).toEqual([]);
	});
});

describe("openSpanPath", () => {
	// Contract: while a startup phase is in flight, openSpanPath names the
	// chain root → deepest open span. The startup watchdog prints this to tell
	// the user which phase a stalled startup is stuck in.
	it("names the deepest in-flight span and clears once settled", async () => {
		logger.startTiming();
		try {
			const gate = Promise.withResolvers<void>();
			const running = logger.time("outer", async () => {
				await logger.time("inner", () => gate.promise);
			});
			expect(logger.openSpanPath()).toEqual(["outer", "inner"]);
			gate.resolve();
			await running;
			expect(logger.openSpanPath()).toEqual([]);
		} finally {
			logger.endTiming();
		}
	});

	it("returns empty when timing is not recording", () => {
		expect(logger.openSpanPath()).toEqual([]);
	});
});
