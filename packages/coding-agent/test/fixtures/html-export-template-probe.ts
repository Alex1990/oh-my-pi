import * as fs from "node:fs";
import * as path from "node:path";
import { getTemplate } from "../../src/export/html/index";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const first = getTemplate();
const removeAssets = process.argv.includes("--remove-assets-after-first-use");
let assetsRemoved = 0;
if (removeAssets) {
	for (const name of fs.readdirSync(import.meta.dirname)) {
		if (
			/^(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js|(?:marked|highlight)\.min-[^.]+\.js)$/.test(
				name,
			)
		) {
			fs.rmSync(path.join(import.meta.dirname, name));
			assetsRemoved++;
		}
	}
}
const repeated = getTemplate();

process.stdout.write(
	JSON.stringify({
		chars: first.length,
		bytes: Buffer.byteLength(first),
		sha256: bun.SHA256.hash(first, "hex"),
		stableCache: repeated === first,
		assetsRemoved,
	}),
);
