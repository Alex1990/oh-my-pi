import { expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import { NativeOAuthCallback } from "../native/index.js";

test("native OAuth validates schemes before starting a receiver", async () => {
	expect(() => new NativeOAuthCallback({ scheme: "../another-handler" })).toThrow();
	const receiver = new NativeOAuthCallback({ scheme: "omp-native-test" });
	await receiver.dispose();
});
