import { once } from "node:events";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
// Transport fixture for resize-tmux-sync.test.ts. Keep the pane alive between
// frames; split UTF-8 and escape sequences like a real backed-up PTY writer.
const directory = process.argv[2]!;
const sink = bun.stdout;
for (let frame = 0; ; frame++) {
	const filename = `${directory}/${frame}.frame`;
	// A BunFile caches a missing stat, so polling requires a fresh handle.
	while (!(await bun.file(filename).exists())) await bun.sleep(10);
	const bytes = await bun.file(filename).bytes();
	for (let offset = 0; offset < bytes.length; offset += 4096) {
		// `process.stdout` back-pressure stands in for Bun's `FileSink.flush()`:
		// wait for the pipe to drain so frames leave one at a time.
		if (sink.write(bytes.subarray(offset, offset + 4096)) === false) await once(process.stdout, "drain");
		await bun.sleep(30);
	}
	await bun.write(`${directory}/${frame}.done`, "done");
}
