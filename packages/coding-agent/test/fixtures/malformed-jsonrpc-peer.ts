import { bun } from "@oh-my-pi/pi-utils/node-runtime";
process.stdin.once("data", () => {
	process.stdout.write("Content-Length: 268435457\r\n\r\n");
});
await bun.sleep(60_000);
