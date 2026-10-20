import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCodeStatus, summarizeCode } from "../native";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

describe("parseCodeStatus", () => {
	it.each([
		["valid source", { code: "const value: number = 1;", path: "fixture.ts" }, "typescript"],
		["syntax errors", { code: "const value: = 1;", path: "fixture.ts" }, null],
		["empty source", { code: "", path: "fixture.ts" }, null],
		["whitespace source", { code: "\n", path: "fixture.ts" }, "typescript"],
		["unsupported path", { code: "const value = 1;", path: "fixture.txt" }, null],
		["unknown explicit language", { code: "const value = 1;", path: "fixture.ts", lang: "unknown-language" }, null],
		[
			"language alias override",
			{ code: "const value: number = 1;", path: "fixture.txt", lang: " ts " },
			"typescript",
		],
		["blank alias fallback", { code: "const value: number = 1;", path: " fixture.ts ", lang: " \t" }, "typescript"],
		["missing language and path", { code: "const value = 1;" }, null],
	] as const)("preserves the summary verdict for %s", (_name, options, language) => {
		const status = parseCodeStatus(options);
		const summary = summarizeCode(options);
		expect(status.parsed).toBe(language !== null);
		expect(status.language ?? null).toBe(language);
		expect(status.parsed).toBe(summary.parsed);
		expect(status.language ?? null).toBe(summary.language ?? null);
	});

	it("reports syntax recovery across repeated edits to the same path", () => {
		const file = `parse-status-${crypto.randomUUID()}.ts`;
		for (const [code, parsed] of [
			["export const café: number = 1;\n", true],
			["export const café: number = (2;\n", false],
			["export const café: number = (2);\n", true],
			["export const café: number = (2);\n", true],
		] as const) {
			expect(parseCodeStatus({ code, path: file }).parsed).toBe(parsed);
		}
	});

	it("distinguishes a missing wasm grammar from a corrupt grammar", async () => {
		const loader = pathToFileURL(
			path.resolve(import.meta.dirname, "../../../scripts/node-runtime-loader.mjs"),
		).href;
		const child = bun.spawn(
			[
				process.execPath,
				"--no-warnings",
				"--experimental-transform-types",
				"--import",
				loader,
				path.join(import.meta.dirname, "fixtures/parse-status-grammar-probe.ts"),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const result = JSON.parse(stdout);
		expect(result.missing).toEqual({ parsed: false, language: null });
		expect(result.statusError).toBe(result.summaryError);
		expect(result.statusError).toContain("the ini grammar is invalid:");
	});
});
