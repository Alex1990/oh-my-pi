import { describe, expect, it } from "@oh-my-pi/pi-utils/test-runtime";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION_STAMP_MAGIC, VERSION_STAMP_SIZE } from "../packages/natives/native/version-sentinel.js";
import { verifyPackagedAddon } from "./package-portable";

const VERSION = "18.12.2";

function image(payload: string): Buffer {
	const slot = Buffer.alloc(VERSION_STAMP_SIZE);
	slot.write(payload, "latin1");
	return Buffer.concat([Buffer.from("\x7fELF-head"), slot, Buffer.from("tail-bytes")]);
}

function stamped(version: string): Buffer {
	return image(`${VERSION_STAMP_MAGIC}${version}`);
}

async function withAddon(bytes: Buffer | null, run: (addonPath: string) => Promise<void>): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oyp-package-portable-"));
	const addonPath = path.join(dir, "pi_natives.darwin-arm64.node");
	try {
		if (bytes) await fs.writeFile(addonPath, bytes);
		await run(addonPath);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("verifyPackagedAddon", () => {
	it("accepts an addon stamped for the packaged release", async () => {
		await withAddon(stamped(VERSION), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).resolves.toBeUndefined();
		});
	});

	it("accepts a pre-stamp addon whose legacy sentinel names the packaged release", async () => {
		await withAddon(image("__piNativesV18_12_2"), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).resolves.toBeUndefined();
		});
	});

	it("rejects the empty stamp slot a raw bazel addon carries", async () => {
		await withAddon(image(VERSION_STAMP_MAGIC), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).rejects.toThrow(
				`does not carry the @oh-my-pi/pi-natives@${VERSION} version stamp`,
			);
		});
	});

	it("rejects an addon stamped for another release", async () => {
		await withAddon(stamped("18.11.0"), async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).rejects.toThrow("does not carry");
		});
	});

	it("reports a missing addon instead of packaging without it", async () => {
		await withAddon(null, async addonPath => {
			await expect(verifyPackagedAddon(addonPath, VERSION)).rejects.toThrow(`Native addon ${addonPath} is missing`);
		});
	});
});
