import { describe, expect, test } from "@oh-my-pi/pi-utils/test-runtime";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

describe("deepseek built-in provider (issue #830)", () => {
	test("registers DeepSeek as an API-key login provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "deepseek");
		expect(provider?.name).toBe("DeepSeek");
		expect(provider?.available).toBe(true);
	});

	test("resolves DEEPSEEK_API_KEY via env", () => {
		const previous = bun.env.DEEPSEEK_API_KEY;
		bun.env.DEEPSEEK_API_KEY = "deepseek-test-key";
		try {
			expect(getEnvApiKey("deepseek")).toBe("deepseek-test-key");
		} finally {
			if (previous === undefined) {
				delete bun.env.DEEPSEEK_API_KEY;
			} else {
				bun.env.DEEPSEEK_API_KEY = previous;
			}
		}
	});
});
