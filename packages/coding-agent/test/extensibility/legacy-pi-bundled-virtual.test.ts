import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ptree, TempDir } from "@oh-my-pi/pi-utils";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { nodeSourceFlags } from "../../src/subprocess/worker-client";

describe("bundled extension modules", () => {
	it("observes active host theme changes and native default/named exports", async () => {
		using dir = TempDir.createSync("@omp-bundled-extension-");
		const entry = dir.join("extension.ts");
		await bun.write(
			entry,
			[
				'import { theme } from "@oh-my-pi/pi-tui/theme";',
				'import format, { double } from "@oh-my-pi/pi-utils/virtual-fixture";',
				"export { theme };",
				'export function render() { return theme.fg("accent", "extension"); }',
				"export function describe(value) { return format(double(value)); }",
			].join("\n"),
		);
		const testDir = import.meta.dirname;
		const themePath = pathToFileURL(path.resolve(testDir, "../../../tui/src/theme/theme.ts")).href;
		const loaderPath = pathToFileURL(path.resolve(testDir, "../../../tui/src/theme/loader.ts")).href;
		const compatPath = pathToFileURL(
			path.resolve(testDir, "../../src/extensibility/plugins/legacy-pi-compat.ts"),
		).href;
		const moduleHooksPath = pathToFileURL(path.resolve(testDir, "../../../utils/src/module-hooks.ts")).href;
		const result = await ptree.exec(
			[
				process.execPath,
				...nodeSourceFlags(),
				"-e",
				`
import * as host from ${JSON.stringify(themePath)};
import { loadThemeSync } from ${JSON.stringify(loaderPath)};
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from ${JSON.stringify(compatPath)};
import { plugin } from ${JSON.stringify(moduleHooksPath)};
plugin({
	name: "bundled-extension-fixture",
	setup(build) {
		build.module("omp-legacy-pi-modules", () => ({
			loader: "object",
			exports: {
				BUNDLED_PI_MODULE_LOADERS: {
					"@oh-my-pi/pi-tui/theme": async () => host,
					"@oh-my-pi/pi-utils/virtual-fixture": async () => ({
						default: value => "value=" + value,
						double: value => value * 2,
					}),
					"unused": async () => { throw new Error("unrelated host module evaluated"); },
				},
			},
		}));
	},
});
installLegacyPiSpecifierShim();
const extension = await loadLegacyPiModule(${JSON.stringify(entry)});
const notifications = [];
const unsubscribe = host.onThemeChange(() => {
	notifications.push(extension.theme === host.theme);
});
host.initThemeSync();
const initialized = extension.theme === host.theme;
host.setThemeInstance(loadThemeSync("dark"));
const before = extension.render();
const previousTheme = extension.theme;
host.setThemeInstance(loadThemeSync("light"));
const after = extension.render();
unsubscribe();
console.log(JSON.stringify({
	initialized,
	changed: before !== after,
	matchesHost: after === host.theme.fg("accent", "extension"),
	liveIdentity: extension.theme === host.theme && previousTheme !== extension.theme,
	uiNotifications: notifications,
	formatted: extension.describe(21),
}));
`,
			],
			{
				env: { ...bun.env, PI_BUNDLED: "1", PI_TEST_RUNTIME: "1", PI_CODING_AGENT_DIR: dir.join("agent") },
				timeout: 15_000,
				allowNonZero: true,
			},
		);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			initialized: true,
			changed: true,
			matchesHost: true,
			liveIdentity: true,
			uiNotifications: [true, true],
			formatted: "value=42",
		});
	});
});
