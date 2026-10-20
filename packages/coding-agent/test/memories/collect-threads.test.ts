import { afterEach, beforeEach, describe, expect, it, spyOn } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { collectThreads } from "@oh-my-pi/pi-coding-agent/memories";
import { bun, type NodeFile } from "@oh-my-pi/pi-utils/node-runtime";

function makeFakeSession(sessionDir: string): AgentSession {
	return {
		sessionManager: {
			getSessionDir: () => sessionDir,
			getCwd: () => sessionDir,
			getSessionId: () => "current-active-session",
		},
	} as unknown as AgentSession;
}

describe("collectThreads", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collect-threads-test-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("parses header from standard session file", async () => {
		const filePath = path.join(tempDir, "sess-1.jsonl");
		await bun.write(
			filePath,
			'{"type":"session","id":"custom-id-1","cwd":"/projects/my-app"}\n{"type":"user","message":"hi"}\n',
		);

		const threads = await collectThreads(makeFakeSession(tempDir));
		expect(threads.length).toBe(1);
		expect(threads[0]?.id).toBe("custom-id-1");
		expect(threads[0]?.cwd).toBe("/projects/my-app");
		expect(threads[0]?.sourceKind).toBe("cli");
	});

	it("filters out the current active thread", async () => {
		const activeFile = path.join(tempDir, "active.jsonl");
		await bun.write(activeFile, '{"type":"session","id":"active-thread","cwd":"/work"}\n');
		const otherFile = path.join(tempDir, "other.jsonl");
		await bun.write(otherFile, '{"type":"session","id":"other-thread","cwd":"/work"}\n');

		const threads = await collectThreads(makeFakeSession(tempDir), "active-thread");
		expect(threads.length).toBe(1);
		expect(threads[0]?.id).toBe("other-thread");
	});

	it("ignores non-jsonl files and degrades malformed entries gracefully", async () => {
		await bun.write(path.join(tempDir, "notes.txt"), "not a session");
		await bun.write(path.join(tempDir, "broken.jsonl"), "{invalid json\n");
		await bun.write(path.join(tempDir, "empty.jsonl"), "");

		const threads = await collectThreads(makeFakeSession(tempDir));
		// broken.jsonl should degrade to id from filename ("broken") and cwd=""
		const broken = threads.find(t => t.id === "broken");
		expect(broken).toBeDefined();
		expect(broken?.cwd).toBe("");
	});

	it("falls back to full read when header crosses the head-cap boundary", async () => {
		const filePath = path.join(tempDir, "padded-boundary.jsonl");
		// Pad the title line so the session header starts near ~64 KB and crosses the boundary
		const longTitle = '{"type":"title","title":"' + "a".repeat(65530) + '"}\n';
		const sessionHeader = '{"type":"session","id":"boundary-id","cwd":"/boundary/dir"}\n';
		await bun.write(filePath, longTitle + sessionHeader + "tail\n");

		const threads = await collectThreads(makeFakeSession(tempDir));
		expect(threads.length).toBe(1);
		expect(threads[0]?.id).toBe("boundary-id");
		expect(threads[0]?.cwd).toBe("/boundary/dir");
	});

	it("extracts header from a large session file whose body exceeds the head cap", async () => {
		const filePath = path.join(tempDir, "big-session.jsonl");
		// Session header line (~70 bytes), then 250 KB of conversation lines
		const header = '{"type":"session","id":"big-id","cwd":"/big/project"}\n';
		const bigBody = ('{"type":"assistant","message":"' + "x".repeat(1000) + '"}\n').repeat(250);
		await bun.write(filePath, header + bigBody);

		let fullTextReads = 0;
		const originalFile = bun.file.bind(bun);
		const fileSpy = spyOn(bun, "file").mockImplementation((target: string | URL | NodeFile) => {
				const file = originalFile(target);
				if (target === filePath) {
					file.text = async () => {
						fullTextReads++;
						throw new Error("full session body read");
					};
				}
				return file;
		});

		try {
			const threads = await collectThreads(makeFakeSession(tempDir));
			expect(fullTextReads).toBe(0);
			expect(threads.length).toBe(1);
			expect(threads[0]?.id).toBe("big-id");
			expect(threads[0]?.cwd).toBe("/big/project");
		} finally {
			fileSpy.mockRestore();
		}
	});
});
