import { Database } from "@oh-my-pi/pi-utils/sqlite-compat";
import { afterEach, describe, expect, test, vi } from "@oh-my-pi/pi-utils/test-runtime";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const originalXaiApiKey = bun.env.XAI_API_KEY;

afterEach(() => {
	if (originalXaiApiKey === undefined) {
		delete bun.env.XAI_API_KEY;
	} else {
		bun.env.XAI_API_KEY = originalXaiApiKey;
	}
	vi.restoreAllMocks();
});

describe("xAI API login wiring", () => {
	test("resolves XAI_API_KEY from environment", () => {
		bun.env.XAI_API_KEY = "xai-env-key";
		expect(getEnvApiKey("xai")).toBe("xai-env-key");
	});

	test("XAI_API_KEY alone does not mark SuperGrok as available", async () => {
		const originalOauthToken = bun.env.XAI_OAUTH_TOKEN;
		bun.env.XAI_API_KEY = "xai-env-key";
		delete bun.env.XAI_OAUTH_TOKEN;
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			expect(storage.keys.source("xai") !== undefined).toBe(true);
			expect(storage.keys.source("xai-oauth") !== undefined).toBe(false);
			expect(storage.keys.source("xai", { env: "aliases" }) !== undefined).toBe(true);
			expect(storage.keys.source("xai-oauth", { env: "aliases" }) !== undefined).toBe(true);
			expect(getEnvApiKey("xai-oauth")).toBe("xai-env-key");
			expect(storage.keys.source("xai")).toEqual({ kind: "env", envVar: "XAI_API_KEY", concrete: true });
			expect(storage.keys.source("xai-oauth")).toBeUndefined();
		} finally {
			if (originalOauthToken === undefined) {
				delete bun.env.XAI_OAUTH_TOKEN;
			} else {
				bun.env.XAI_OAUTH_TOKEN = originalOauthToken;
			}
			store.close();
		}
	});

	test("XAI_OAUTH_TOKEN marks SuperGrok available without a paid API key", async () => {
		const originalOauthToken = bun.env.XAI_OAUTH_TOKEN;
		delete bun.env.XAI_API_KEY;
		bun.env.XAI_OAUTH_TOKEN = "xai-oauth-env";
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();
		try {
			expect(storage.keys.source("xai") !== undefined).toBe(false);
			expect(storage.keys.source("xai-oauth") !== undefined).toBe(true);
			expect(storage.keys.source("xai-oauth")).toEqual({ kind: "env", concrete: true });
		} finally {
			if (originalOauthToken === undefined) {
				delete bun.env.XAI_OAUTH_TOKEN;
			} else {
				bun.env.XAI_OAUTH_TOKEN = originalOauthToken;
			}
			store.close();
		}
	});

	test("AuthStorage.oauth.login('xai') validates against /models and stores the pasted key", async () => {
		const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			let url: string;
			if (typeof input === "string") {
				url = input;
			} else if (input instanceof URL) {
				url = input.toString();
			} else {
				url = input.url;
			}
			fetchCalls.push({ url, init });
			if (url === "https://api.x.ai/v1/models") {
				return new Response(JSON.stringify({ data: [{ id: "grok-4" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		});

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();

		await storage.oauth.login("xai", {
			onAuth: () => {},
			onPrompt: async () => "xai-validated",
			fetch: fetchMock,
		});

		const credential = await storage.credentials.get("xai");
		expect(credential).toEqual({ type: "api_key", key: "xai-validated", source: "login" });

		const modelsCall = fetchCalls.find(call => call.url.endsWith("/v1/models"));
		expect(modelsCall).toBeDefined();
		const headers = new Headers(modelsCall?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer xai-validated");

		store.close();
	});

	test("AuthStorage.oauth.login('xai') rejects keys that fail /models validation", async () => {
		const fetchMock: FetchImpl = vi.fn(
			async () =>
				new Response("Unauthorized", {
					status: 401,
					headers: { "Content-Type": "text/plain" },
				}),
		);

		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();

		await expect(
			storage.oauth.login("xai", {
				onAuth: () => {},
				onPrompt: async () => "xai-bogus",
				fetch: fetchMock,
			}),
		).rejects.toThrow(/xAI API key validation failed \(401\)/);

		expect(await storage.credentials.get("xai")).toBeUndefined();
		store.close();
	});
});
