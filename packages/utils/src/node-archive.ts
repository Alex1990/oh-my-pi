/**
 * `Bun.Archive` replacement over the repository's archive toolkit.
 *
 * Bun's `Archive` read zip/tar-family containers from memory or a path and wrote
 * them back (`new Archive(bytes).files()`, `new Archive(entries, { compress }).blob()`).
 * This adapter keeps that surface on top of `@oh-my-pi/pi-utils/ar`'s reader and
 * writer, which already implement every container format the repo uses.
 */
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import { encodeArchive, openArchive } from "./ar";
import type { ArchiveFormat, ArchiveMemberContent, WritableArchiveFormat } from "./ar/types";

export interface ArchiveOptions {
	/** `"gzip"` wraps tar output in gzip; ignored for zip/asar. */
	compress?: "gzip" | "none";
	/** Compression level passed through to the writer. */
	level?: number;
}

type ArchiveInput = Uint8Array | ArrayBuffer | Record<string, ArchiveMemberContent> | Map<string, ArchiveMemberContent>;

/** Detect the container format of in-memory bytes. */
function detectFormat(bytes: Uint8Array): ArchiveFormat {
	if (bytes.length >= 4) {
		// PK\x03\x04 / PK\x05\x06 / PK\x07\x08 — zip family.
		if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
		// \x1f\x8b — gzip-wrapped tar.
		if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "tar.gz";
	}
	// asar has an 8-byte size header then a JSON pickle; treat everything else as tar.
	return "tar";
}

/** In-memory archive, shaped like `Bun.Archive`. */
export class Archive {
	readonly #bytes: Uint8Array | null;
	readonly #entries: Map<string, ArchiveMemberContent> | null;
	readonly #format: WritableArchiveFormat;

	constructor(input: ArchiveInput, options: ArchiveOptions = {}) {
		if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
			const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
			this.#bytes = bytes;
			this.#entries = null;
			const detected = detectFormat(bytes);
			this.#format = detected === "tar.gz" || detected === "zip" ? detected : "tar";
			return;
		}
		this.#bytes = null;
		this.#entries = input instanceof Map ? new Map(input) : new Map(Object.entries(input));
		this.#format = options.compress === "gzip" ? "tar.gz" : "tar";
	}

	/** Every regular file in the archive, keyed by member path. */
	async files(): Promise<Map<string, File>> {
		if (!this.#bytes) {
			const files = new Map<string, File>();
			for (const [name, content] of this.#entries ?? []) {
				files.set(name, new File([await memberBytes(content)], path.basename(name)));
			}
			return files;
		}
		const reader = await openArchive({ bytes: this.#bytes, format: detectFormat(this.#bytes) });
		const files = new Map<string, File>();
		for (const entry of reader.indexEntries()) {
			if (entry.isDirectory) continue;
			const extracted = await reader.readFile(entry.path);
			files.set(entry.path, new File([extracted.bytes], path.basename(entry.path)));
		}
		return files;
	}

	/** Serialize this archive to bytes. */
	async bytes(): Promise<Uint8Array> {
		if (this.#bytes) return this.#bytes;
		return await encodeArchive(this.#format, this.#entries ?? []);
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.bytes()], { type: this.#format === "zip" ? "application/zip" : "application/x-tar" });
	}

	/** Write the serialized archive and return its byte count. */
	async write(destination: string): Promise<number> {
		const bytes = await this.bytes();
		await writeFile(destination, bytes);
		return bytes.byteLength;
	}
}

async function memberBytes(content: ArchiveMemberContent): Promise<Uint8Array> {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
	return content;
}
