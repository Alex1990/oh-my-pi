import { heapStats } from "@oh-my-pi/pi-utils/jsc-compat";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const manager = SessionManager.inMemory();

async function collectHeapSize(): Promise<number> {
	for (let pass = 0; pass < 3; pass++) {
		await bun.sleep(0);
		bun.gc(true);
	}
	// V8 reports large string payloads as external memory, unlike JSC's heapSize.
	const stats = heapStats();
	return stats.heapSize + stats.extraMemorySize;
}

async function saveBulkArtifact(): Promise<void> {
	await manager.saveArtifact(Buffer.alloc(8 * 1024 * 1024, 0x61).toString("base64"), "read");
}

const baselineBytes = await collectHeapSize();
await saveBulkArtifact();
const liveBytes = await collectHeapSize();
await manager.close();
manager.releaseRetainedEntries();
const releasedBytes = await collectHeapSize();

process.stdout.write(
	JSON.stringify({ baselineBytes, liveBytes, releasedBytes, retainedEntries: manager.getEntries().length }),
);
