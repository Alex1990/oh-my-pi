import { preconnectOf } from "@oh-my-pi/pi-ai/utils/fetch-preconnect";
import { afterEach, describe, expect, it, vi } from "@oh-my-pi/pi-utils/test-runtime";
import { pollSmitheryCliAuthSession } from "../../src/mcp/smithery-auth";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit;

describe("pollSmitheryCliAuthSession fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("bounds each poll request with a timeout abort signal even without a caller signal", async () => {
		const signals: AbortSignal[] = [];
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				if (init?.signal instanceof AbortSignal) signals.push(init.signal);
				return Response.json({ status: "pending" });
			},
			{ preconnect: preconnectOf(globalThis.fetch) },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const result = await pollSmitheryCliAuthSession("sess-123");

		expect(result.status).toBe("pending");
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
	});
});
