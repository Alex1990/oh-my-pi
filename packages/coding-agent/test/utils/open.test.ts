import { afterEach, beforeEach, describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";
import * as path from "node:path";
import { openPath } from "@oh-my-pi/pi-coding-agent/utils/open";
import type * as PiUtils from "@oh-my-pi/pi-utils";
import type * as NodeRuntime from "@oh-my-pi/pi-utils/node-runtime";
import {
	type SpawnOptions,
	type SpawnSyncOptions,
	type SpawnSyncResult,
	type Subprocess,
} from "@oh-my-pi/pi-utils/node-runtime";
// Mock hoisting needs the real Vitest entry point; the test-runtime barrel
// re-exports it, which Vitest's mock-API check rejects.
import { vi } from "vitest";

/**
 * ESM module namespaces are frozen, so these cannot be `vi.spyOn`-ed. Mock the
 * modules instead and delegate to the real implementations unless a test
 * overrides them.
 */
const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
	existsSync: vi.fn(),
	resolve: vi.fn(),
	which: vi.fn(),
	warn: vi.fn(),
	actual: {} as {
		fs?: typeof NodeFs;
		path?: typeof NodePath;
		utils?: typeof PiUtils;
	},
}));

vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof NodeFs>();
	mocks.actual.fs = actual;
	mocks.existsSync.mockImplementation(candidate => actual.existsSync(candidate));
	return { ...actual, existsSync: mocks.existsSync };
});

vi.mock("node:path", async importOriginal => {
	const actual = await importOriginal<typeof NodePath>();
	mocks.actual.path = actual;
	mocks.resolve.mockImplementation((...segments: string[]) => actual.resolve(...segments));
	return { ...actual, resolve: mocks.resolve };
});

vi.mock("@oh-my-pi/pi-utils", async importOriginal => {
	const actual = await importOriginal<typeof PiUtils>();
	mocks.actual.utils = actual;
	mocks.which.mockImplementation(command => actual.$which(command));
	return { ...actual, $which: mocks.which, logger: { ...actual.logger, warn: mocks.warn } };
});

vi.mock("@oh-my-pi/pi-utils/node-runtime", async importOriginal => {
	const actual = await importOriginal<typeof NodeRuntime>();
	return { ...actual, bun: { ...actual.bun, spawn: mocks.spawn, spawnSync: mocks.spawnSync } };
});

type SpawnCall = { cmd: string[]; options: SpawnOptions };

const existingLinuxPath = "/mnt/c/Users/example/Downloads/session.html";
const windowsPath = "C:\\Users\\example\\Downloads\\session.html";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const ENV_KEYS = ["WSL_DISTRO_NAME", "WSL_INTEROP"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
}

function fakeProcess(): Subprocess {
	return {
		pid: 1,
		exited: Promise.resolve(0),
		kill: () => true,
	} as unknown as Subprocess;
}

function spySpawn(calls: SpawnCall[]) {
	function mockSpawn(
		command: string | string[] | ({ cmd: string[] } & SpawnOptions),
		options?: SpawnOptions,
	): Subprocess {
		const cmd = typeof command === "string" ? [command] : Array.isArray(command) ? command : command.cmd;
		const resolved: SpawnOptions =
			typeof command === "object" && !Array.isArray(command) ? { ...command, ...options } : (options ?? {});
		calls.push({ cmd, options: resolved });
		return fakeProcess();
	}
	mocks.spawn.mockImplementation(mockSpawn);
	return mocks.spawn;
}

function spyWslPath(calls: string[][], output: string, exitCode = 0) {
	const result = {
		stdout: Buffer.from(output),
		stderr: null,
		exitCode,
		success: exitCode === 0,
		resourceUsage: {},
		pid: 1,
	} as unknown as SpawnSyncResult;

	function mockSpawnSync(command: string[] | string | { cmd: string[] }, _options?: SpawnSyncOptions): SpawnSyncResult {
		calls.push(typeof command === "string" ? [command] : Array.isArray(command) ? command : command.cmd);
		return result;
	}
	mocks.spawnSync.mockImplementation(mockSpawnSync);
	return mocks.spawnSync;
}

beforeEach(() => {
	// `restoreMocks` clears implementations before every test.
	mocks.existsSync.mockImplementation(candidate => mocks.actual.fs!.existsSync(candidate));
	mocks.resolve.mockImplementation((...segments: string[]) => mocks.actual.path!.resolve(...segments));
	mocks.which.mockImplementation(command => mocks.actual.utils!.$which(command));
	mocks.spawn.mockReset();
	mocks.spawnSync.mockReset();

	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = savedEnv[key];
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	restorePlatform();
	vi.restoreAllMocks();
});

describe("openPath", () => {
	it("opens existing WSL mount files through wslview with a Windows path", () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		// Keep the mocked linux platform deterministic on a Windows dev host:
		// the real path.resolve would rewrite /mnt/c/… against the drive root.
		const realResolve = path.resolve;
		mocks.resolve.mockImplementation((...segments: string[]) =>
			segments.length === 1 && segments[0] === existingLinuxPath ? existingLinuxPath : realResolve(...segments),
		);
		mocks.which.mockImplementation(command => (command === "wslview" ? "/usr/bin/wslview" : null));
		mocks.existsSync.mockImplementation(candidate => candidate === existingLinuxPath);

		const spawnSyncCalls: string[][] = [];
		spyWslPath(spawnSyncCalls, windowsPath);
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath(existingLinuxPath);

		expect(spawnSyncCalls).toEqual([["wslpath", "-w", existingLinuxPath]]);
		expect(spawnCalls.map(call => call.cmd)).toEqual([["wslview", windowsPath]]);
	});

	it("keeps WSL URL opening on xdg-open without path conversion", () => {
		setPlatform("linux");
		process.env.WSL_INTEROP = "/run/WSL/1_interop";
		mocks.which.mockReturnValue("/usr/bin/wslview");
		const spawnSyncSpy = mocks.spawnSync;
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath("https://example.com");

		expect(spawnSyncSpy).not.toHaveBeenCalled();
		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", "https://example.com"]]);
	});

	it("falls back to xdg-open when wslview is unavailable", () => {
		setPlatform("linux");
		process.env.WSL_DISTRO_NAME = "Ubuntu";
		mocks.which.mockReturnValue(null);
		const spawnSyncSpy = mocks.spawnSync;
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath(existingLinuxPath);

		expect(spawnSyncSpy).not.toHaveBeenCalled();
		expect(spawnCalls.map(call => call.cmd)).toEqual([["xdg-open", existingLinuxPath]]);
	});

	it("resolves PowerShell through %SystemRoot% so a broken machine PATH cannot silence the opener", () => {
		setPlatform("win32");
		const originalSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = "D:\\CustomWindows";
		const powershellPath = "D:\\CustomWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		mocks.existsSync.mockImplementation(candidate => candidate === powershellPath);
		try {
			const spawnCalls: SpawnCall[] = [];
			spySpawn(spawnCalls);

			const url = "https://mcp.linear.app/authorize?state=xyz&code_challenge_method=S256";
			openPath(url);

			expect(spawnCalls).toHaveLength(1);
			const [call] = spawnCalls;
			// Absolute PowerShell path — bare executable names were the whole bug
			// on Windows boxes where the machine PATH no longer references
			// System32.
			expect(call?.cmd[0]).toBe(powershellPath);
			expect(call?.cmd.slice(1, -1)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
			expect(call?.options.windowsHide).toBe(true);
			// The target rides inside the UTF-16LE payload: no cmd/PowerShell
			// metacharacter parsing ever sees the `&` in the query string, and the
			// terminating error preference makes Start-Process failures exit 1 so
			// openPath's non-zero-exit telemetry observes them (rundll32 always
			// exited 0).
			const decoded = Buffer.from(String(call?.cmd.at(-1)), "base64").toString("utf16le");
			expect(decoded).toBe(`$ErrorActionPreference='Stop';Start-Process '${url}'`);
		} finally {
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
		}
	});

	it("doubles embedded single quotes so the target stays one PowerShell literal", () => {
		setPlatform("win32");
		mocks.existsSync.mockReturnValue(true);
		const spawnCalls: SpawnCall[] = [];
		spySpawn(spawnCalls);

		openPath("C:\\Users\\o'brien\\report.html");

		const decoded = Buffer.from(String(spawnCalls[0]?.cmd.at(-1)), "base64").toString("utf16le");
		expect(decoded).toBe("$ErrorActionPreference='Stop';Start-Process 'C:\\Users\\o''brien\\report.html'");
	});

	it("falls back to C:\\Windows for PowerShell when SystemRoot is unset, and to the bare name when absent", () => {
		setPlatform("win32");
		const originalSystemRoot = process.env.SystemRoot;
		const originalSystemRootLower = process.env.SYSTEMROOT;
		delete process.env.SystemRoot;
		delete process.env.SYSTEMROOT;
		try {
			const defaultPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
			const existsSpy = mocks.existsSync.mockImplementation(candidate => candidate === defaultPath);
			const spawnCalls: SpawnCall[] = [];
			spySpawn(spawnCalls);

			openPath("https://example.com");
			expect(spawnCalls[0]?.cmd[0]).toBe(defaultPath);

			// Exotic layout: resolved path missing → bare name via PATH.
			existsSpy.mockReturnValue(false);
			openPath("https://example.com");
			expect(spawnCalls[1]?.cmd[0]).toBe("powershell.exe");
		} finally {
			if (originalSystemRoot !== undefined) process.env.SystemRoot = originalSystemRoot;
			if (originalSystemRootLower !== undefined) process.env.SYSTEMROOT = originalSystemRootLower;
		}
	});

	it("logs when the opener exits non-zero so Start-Process failures are diagnosable", async () => {
		setPlatform("win32");
		mocks.existsSync.mockReturnValue(true);
		const warnSpy = mocks.warn.mockImplementation((() => {}) as never);
		const failing = {
			pid: 1,
			exited: Promise.resolve(1),
			kill: () => true,
		} as unknown as Subprocess;
		mocks.spawn.mockImplementation(() => failing);

		openPath("https://example.com");
		await failing.exited;
		await Promise.resolve();

		expect(warnSpy).toHaveBeenCalledWith(
			"External opener exited with non-zero status",
			expect.objectContaining({ exitCode: 1 }),
		);
	});
});
