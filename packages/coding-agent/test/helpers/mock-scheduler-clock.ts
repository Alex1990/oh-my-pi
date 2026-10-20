import { vi } from "@oh-my-pi/pi-utils/test-runtime";
import { scheduler } from "node:timers/promises";

/** Resolve scheduler waits immediately while advancing the monotonic clock by the requested delay. */
export function mockSchedulerWaitWithClock() {
	const now = performance.now.bind(performance);
	let advancedMs = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now() + advancedMs);
	return vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		advancedMs += delayMs;
		options?.signal?.throwIfAborted();
	});
}
