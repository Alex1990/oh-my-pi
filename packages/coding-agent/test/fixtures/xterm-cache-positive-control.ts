import { statSync } from "node:fs";
import "@oh-my-pi/pi-utils/vterm";

const paths = Object.keys(require.cache)
	.filter(modulePath => modulePath.replaceAll("\\", "/").includes("/packages/utils/src/vterm"))
	.sort();
const bytes = paths.reduce((total, modulePath) => total + statSync(modulePath).size, 0);
const memory = process.memoryUsage();
await bun.write(
	bun.stdout,
	JSON.stringify({ modules: paths.length, bytes, rss: memory.rss, heapUsed: memory.heapUsed, paths }),
);
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
