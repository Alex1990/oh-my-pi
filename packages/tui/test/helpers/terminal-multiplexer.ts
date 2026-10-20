import { afterEach, beforeEach } from "@oh-my-pi/pi-utils/test-runtime";
import { TERMINAL_MULTIPLEXER_ENV_KEYS } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

/**
 * Neutralize every terminal-multiplexer signal for the calling test file.
 *
 * Multiplexer session markers and a `tmux`/`screen` `TERM` route rendering down
 * the path that cannot rebuild scrollback, and Warp's `TERM_PROGRAM` or
 * `PI_TUI_RESIZE_IN_PLACE` select the in-place resize path. Tests that assert the
 * destructive full-paint behavior otherwise fail for anyone running the suite
 * inside a multiplexer. Restores whatever was set afterwards.
 */
export function withoutTerminalMultiplexer(): void {
	const keys = [...TERMINAL_MULTIPLEXER_ENV_KEYS, "TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"];
	const previous = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of keys) {
			previous.set(key, bun.env[key]);
			delete bun.env[key];
		}
	});

	afterEach(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete bun.env[key];
			else bun.env[key] = value;
		}
		previous.clear();
	});
}
