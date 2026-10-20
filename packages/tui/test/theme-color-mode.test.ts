import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import { colorToAnsi, detectColorMode } from "@oh-my-pi/pi-tui/theme/color";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { nodeEvalArgs } from "./helpers/node-subprocess";

describe("theme color mode", () => {
	it("emits 256-color SGR for macOS Terminal.app", () => {
		const mode = detectColorMode({ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" });

		expect(mode).toBe("256color");
		expect(colorToAnsi("#f5e0ac", mode)).toBe("\x1b[38;5;223m");
	});

	it("keeps repeated foreground conversions separate across color depths", () => {
		expect(colorToAnsi("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
		expect(colorToAnsi("#f5e0ac", "256color")).toBe("\x1b[38;5;223m");
		expect(colorToAnsi("#f5e0ac", "truecolor")).toBe("\x1b[38;2;245;224;172m");
	});

	it("emits 256-color session accents for macOS Terminal.app", async () => {
		// Packaged entry points cannot resolve this package from inside the
		// workspace, so point the child at the source file directly.
		const script = `import { getSessionAccentAnsi } from ${JSON.stringify(
			pathToFileURL(path.resolve(import.meta.dirname, "../src/theme/session-color.ts")).href,
		)};
process.stdout.write(getSessionAccentAnsi("#f5e0ac") ?? "undefined");`;
		const proc = bun.spawn([process.execPath, ...nodeEvalArgs(script)], {
			cwd: path.resolve(import.meta.dirname, "../../.."),
			env: {
				...process.env,
				KITTY_WINDOW_ID: "",
				GHOSTTY_RESOURCES_DIR: "",
				WEZTERM_PANE: "",
				ITERM_SESSION_ID: "",
				VSCODE_PID: "",
				ALACRITTY_WINDOW_ID: "",
				TERM_PROGRAM: "Apple_Terminal",
				TERM: "xterm-256color",
				COLORTERM: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stdout).toBe("\x1b[38;5;223m");
	});
});
