import { vi } from "@oh-my-pi/pi-utils/test-runtime";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isTuiTight, setTuiTight } from "@oh-my-pi/pi-tui";
import { getAgentDir, getProjectDir, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

export interface SettingsTestState {
	agentDir: string;
	env: Record<string, string | undefined>;
	projectDir: string;
	tuiTight: boolean;
}

export function beginSettingsTest(): SettingsTestState {
	const env: Record<string, string | undefined> = {};
	for (const key in process.env) {
		env[key] = process.env[key];
	}
	for (const key in bun.env) {
		env[key] = bun.env[key];
	}
	const state: SettingsTestState = {
		agentDir: getAgentDir(),
		env,
		projectDir: getProjectDir(),
		tuiTight: isTuiTight(),
	};
	resetSettingsForTest();
	return state;
}

export function restoreSettingsTestState(state: SettingsTestState | undefined): void {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (!state) return;

	restoreEnv(state.env);
	setProjectDir(state.projectDir);
	setAgentDir(state.agentDir);
	setTuiTight(state.tuiTight);
	restoreEnvValue("PI_CODING_AGENT_DIR", state.env.PI_CODING_AGENT_DIR);
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
	for (const key in process.env) {
		if (!(key in snapshot)) {
			restoreEnvValue(key, undefined);
		}
	}
	for (const key in bun.env) {
		if (!(key in snapshot)) {
			restoreEnvValue(key, undefined);
		}
	}
	for (const key in snapshot) {
		restoreEnvValue(key, snapshot[key]);
	}
}

/** Restores an environment variable without coercing an absent value to `"undefined"`. */
export function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete bun.env[key];
		return;
	}
	process.env[key] = value;
	bun.env[key] = value;
}
