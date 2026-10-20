import { afterEach, beforeEach, describe, expect, it, spyOn } from "@oh-my-pi/pi-utils/test-runtime";
import { vi } from "vitest";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type * as NodeFsPromisesModule from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool, SNAPSHOT_MAX_BYTES } from "@oh-my-pi/pi-coding-agent/tools/read";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

// Node's `FileHandle` keeps `close()` as an own property (unlike Bun's prototype
// method), so the race hook wraps each handle returned by the mocked module.
const fsOpen = vi.hoisted(() => ({
	onClose: undefined as undefined | ((handle: FileHandle) => Promise<void>),
}));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof NodeFsPromisesModule>();
	return {
		...actual,
		open: async (filePath: PathLike, flags?: string | number, mode?: number): Promise<FileHandle> => {
			const handle = await actual.open(filePath, flags as string, mode);
			const realClose = handle.close.bind(handle);
			handle.close = async () => {
				await realClose();
				await fsOpen.onClose?.(handle);
			};
			return handle;
		},
	};
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

describe("read :-N tail on a file edited between the count and the window read", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-tail-race-"));
	});

	afterEach(async () => {
		fsOpen.onClose = undefined;
		vi.restoreAllMocks();
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("returns the file's current last lines", async () => {
		const filePath = path.join(testDir, "big.log");
		// Past the whole-file snapshot size, so the tail is located by a separate scan.
		const lineCount = Math.ceil(SNAPSHOT_MAX_BYTES / 16) + 1_000;
		const lines = Array.from({ length: lineCount }, (_, index) => `line-${String(index).padStart(12, "0")}`);
		await bun.write(filePath, `${lines.join("\n")}\n`);
		const session: ToolSession = {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tool = new ReadTool(session);

		// The tail scan reads the whole file through one handle, then closes it before the
		// window read reopens the file: edit the file at that close.
		const probe = await fs.open(filePath, "r");
		const handleProto: {
			read(...args: unknown[]): Promise<{ bytesRead: number }>;
		} = Object.getPrototypeOf(probe);
		await probe.close();
		const fileSize = (await fs.stat(filePath)).size;
		const bytesReadBy = new WeakMap<object, number>();
		const realRead = handleProto.read;
		spyOn(handleProto, "read").mockImplementation(async function (this: object, ...args: unknown[]) {
			const result = await realRead.apply(this, args);
			bytesReadBy.set(this, (bytesReadBy.get(this) ?? 0) + result.bytesRead);
			return result;
		});
		let edited = false;
		fsOpen.onClose = async handle => {
			if (edited || (bytesReadBy.get(handle) ?? 0) < fileSize) return;
			edited = true;
			// An earlier line grows: same line count, shifted offsets.
			lines[0] = `${lines[0]}-rewritten-earlier-line`;
			await bun.write(filePath, `${lines.join("\n")}\n`);
		};

		const output = textOf(await tool.execute("tail", { path: `${filePath}:-2` }));
		expect(edited).toBe(true);
		// The selected tail plus one leading context line, each whole.
		expect(output.split("\n").map(row => row.slice(row.indexOf(":") + 1))).toEqual(lines.slice(-3));
	});
});
