import { afterEach, describe, expect, it, spyOn } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getEditorCommand, openInEditor, resolveEditorSpawnCommand } from "../src/utils/external-editor";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

function setPlatform(value: NodeJS.Platform): void {
	// `process.platform` is a non-writable accessor in Node; direct assignment
	// throws. The property is configurable, so redefine it instead.
	Object.defineProperty(process, "platform", { value, configurable: true });
}

describe("getEditorCommand", () => {
	const originalPlatform = process.platform;
	const originalVisual = bun.env.VISUAL;
	const originalEditor = bun.env.EDITOR;

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete bun.env.VISUAL;
		else bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete bun.env.EDITOR;
		else bun.env.EDITOR = originalEditor;
	});

	it("prefers $VISUAL over $EDITOR and the platform default", () => {
		bun.env.VISUAL = "nvim";
		bun.env.EDITOR = "nano";
		setPlatform("win32");
		expect(getEditorCommand()).toBe("nvim");
	});

	it("falls back to $EDITOR when $VISUAL is unset", () => {
		delete bun.env.VISUAL;
		bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("nano");
	});

	it("trims whitespace so an accidentally padded value still works", () => {
		bun.env.VISUAL = "  code --wait  ";
		delete bun.env.EDITOR;
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("treats a whitespace-only $VISUAL as unset and consults $EDITOR", () => {
		bun.env.VISUAL = "   ";
		bun.env.EDITOR = "vim";
		expect(getEditorCommand()).toBe("vim");
	});

	it("defaults to notepad on Windows when neither variable is set", () => {
		delete bun.env.VISUAL;
		delete bun.env.EDITOR;
		setPlatform("win32");
		expect(getEditorCommand()).toBe("notepad");
	});

	it("returns undefined on POSIX when neither variable is set", () => {
		delete bun.env.VISUAL;
		delete bun.env.EDITOR;
		setPlatform("linux");
		expect(getEditorCommand()).toBeUndefined();
	});
});

describe("openInEditor", () => {
	it("always inherits the pane stdio", async () => {
		const spawn = spyOn(bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
		} as never);
		try {
			await openInEditor("editor", "original", {
				extension: ".md",
				stdio: [0, 1, 2],
			} as never);

			expect(spawn).toHaveBeenCalledTimes(1);
			expect(spawn.mock.calls[0]?.[1]).toMatchObject({
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
		} finally {
			spawn.mockRestore();
		}
	});

	it("passes the cmd.exe command line verbatim on Windows", () => {
		const tmpFile = String.raw`C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md`;

		expect(resolveEditorSpawnCommand('"C:\\Program Files\\Code.exe" --wait', tmpFile, "win32")).toEqual({
			cmd: [
				"cmd.exe",
				"/d",
				"/s",
				"/c",
				String.raw`""C:\Program Files\Code.exe" --wait "C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md""`,
			],
			windowsVerbatimArguments: true,
		});
	});

	it.skipIf(process.platform === "win32")("supports quoted editor paths containing spaces", async () => {
		const tempDir = TempDir.createSync("@external-editor-");
		try {
			const editorPath = path.join(tempDir.path(), "My Editor", "edit");
			fs.mkdirSync(path.dirname(editorPath), { recursive: true });
			await bun.write(editorPath, '#!/bin/sh\nprintf "edited" > "$1"\n');
			fs.chmodSync(editorPath, 0o755);

			const result = await openInEditor(`"${editorPath}"`, "original");

			expect(result).toBe("edited");
		} finally {
			await tempDir.remove();
		}
	});
});
