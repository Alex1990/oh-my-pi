/**
 * Node.js implementations of the Bun runtime APIs this repository used to call.
 *
 * Every entry point here is backed by Node built-ins (`node:fs`, `node:child_process`,
 * `node:crypto`, `node:zlib`, …) or plain npm libraries that run on Node — nothing
 * forwards to a Bun runtime. Call sites import `bun` from this module instead of
 * touching a `Bun` global:
 *
 *    *   const text = await bun.file(path).text();
 *
 * The shapes mirror Bun's public API so migrations stay mechanical, while the
 * semantics are Node's. Where Node has no exact equivalent the doc comment on the
 * export states the substituted behavior.
 */
import { type ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants, tmpdir } from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type InspectOptions, inspect as nodeInspect, isDeepStrictEqual } from "node:util";
import * as v8 from "node:v8";
import { isMainThread } from "node:worker_threads";
import { serve as serveHttp } from "./node-serve";
import * as zlib from "node:zlib";
import JSON5Module from "json5";
import { parse as parseJsonc } from "jsonc-parser";
import semverModule from "semver";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import stringWidthModule from "string-width";
import wrapAnsiModule from "wrap-ansi";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** `string-width` ships a callable default in every published major; keep the cast local. */
const measureWidth = stringWidthModule as unknown as (
	input: string,
	options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean },
) => number;
const wrapToWidth = wrapAnsiModule as unknown as (
	input: string,
	columns: number,
	options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean },
) => string;

// ---------------------------------------------------------------------------
// TC39 base64 codec (Bun runtime extension)
// ---------------------------------------------------------------------------

/**
 * Options accepted by the TC39 `Uint8Array` base64 proposal. Bun shipped these
 * methods natively; Node 24 does not, so every consumer of `bytes.toBase64()`
 * and `Uint8Array.fromBase64()` would otherwise crash.
 */
interface Base64CodecOptions {
	alphabet?: "base64" | "base64url";
	omitPadding?: boolean;
	lastChunkHandling?: "loose" | "strict" | "stop-before-partial";
}

type Base64Uint8Array = Uint8Array & {
	toBase64?: (options?: Base64CodecOptions) => string;
};

const uint8ArrayBase64 = Uint8Array as unknown as {
	prototype: Base64Uint8Array;
	fromBase64?: (input: string, options?: Base64CodecOptions) => Uint8Array;
};

if (typeof uint8ArrayBase64.prototype.toBase64 !== "function") {
	uint8ArrayBase64.prototype.toBase64 = function toBase64(this: Uint8Array, options?: Base64CodecOptions): string {
		const encoded = Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString(
			options?.alphabet === "base64url" ? "base64url" : "base64",
		);
		return options?.omitPadding ? encoded.replace(/=+$/, "") : encoded;
	};
}

if (typeof uint8ArrayBase64.fromBase64 !== "function") {
	uint8ArrayBase64.fromBase64 = (input: string, options?: Base64CodecOptions): Uint8Array => {
		const decoded = Buffer.from(input, options?.alphabet === "base64url" ? "base64url" : "base64");
		return new Uint8Array(decoded);
	};
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Node-backed replacement for `BunFile`. Reads are lazy; metadata uses `statSync`.
 *
 * Structurally satisfies the DOM `Blob` interface (`textStream` included), so a
 * file handle is accepted anywhere a `Blob`/`BodyInit` is.
 */
export class NodeFile {
	readonly #path: string;
	readonly #start: number | undefined;
	readonly #end: number | undefined;

	constructor(target: string | URL | NodeFile, start?: number, end?: number) {
		if (target instanceof NodeFile) {
			this.#path = target.#path;
			this.#start = start ?? target.#start;
			this.#end = end ?? target.#end;
			return;
		}
		this.#path = typeof target === "string" ? path.resolve(target) : fileURLToPath(target);
		this.#start = start;
		this.#end = end;
	}

	/** Absolute filesystem path. */
	get name(): string {
		return this.#path;
	}

	/** Alias kept for call sites that read `.path` instead of `.name`. */
	get path(): string {
		return this.#path;
	}

	/** Byte length of the (sliced) file; `0` when the file does not exist. */
	get size(): number {
		let total: number;
		try {
			total = fs.statSync(this.#path).size;
		} catch {
			return 0;
		}
		const start = this.#start ?? 0;
		const end = this.#end ?? total;
		return Math.max(0, Math.min(end, total) - start);
	}

	/** Modification time in milliseconds since the epoch. */
	get lastModified(): number {
		try {
			return fs.statSync(this.#path).mtimeMs;
		} catch {
			return 0;
		}
	}

	/** Best-effort MIME type derived from the file extension. */
	get type(): string {
		return mimeTypeForPath(this.#path);
	}

	async exists(): Promise<boolean> {
		try {
			await fsp.access(this.#path, fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	slice(begin?: number, end?: number): NodeFile {
		const base = this.#start ?? 0;
		const limit = this.#end ?? base + this.size;
		const start = base + Math.max(0, begin ?? 0);
		const stop = end === undefined ? limit : Math.min(limit, base + Math.max(0, end));
		return new NodeFile(this.#path, Math.min(start, stop), stop);
	}

	async text(): Promise<string> {
		return (await this.#read()).toString("utf8");
	}

	/** Bun typed this as `any`; keeping that keeps `await file.json()` property access source-compatible. */
	async json<T = unknown>(): Promise<T> {
		return JSON.parse(await this.text()) as T;
	}

	async bytes(): Promise<Uint8Array> {
		const bytes = await this.#read();
		return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		const bytes = await this.#read();
		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	}

	async blob(): Promise<Blob> {
		const bytes = await this.bytes();
		// DOM `BlobPart` wants an `ArrayBuffer`-backed view; a pooled Buffer slice
		// may be `ArrayBufferLike`, so copy the exact window.
		return new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
			type: this.type,
		});
	}

	/** UTF-8 line stream, part of the DOM `Blob` surface. */
	textStream(): ReadableStream<string> {
		const bytes = this.stream();
		const decoder = new TextDecoder();
		return bytes.pipeThrough(
			new TransformStream<Uint8Array, string>({
				transform(chunk, controller) {
					const text = decoder.decode(chunk, { stream: true });
					if (text.length > 0) controller.enqueue(text);
				},
				flush(controller) {
					const tail = decoder.decode();
					if (tail.length > 0) controller.enqueue(tail);
				},
			}),
		);
	}

	stream(): ReadableStream<Uint8Array> {
		const nodeStream = fs.createReadStream(this.#path, {
			start: this.#start,
			end: this.#end === undefined ? undefined : Math.max(0, this.#end - 1),
		});
		return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
	}

	writer(options?: { highWaterMark?: number }): FileSink {
		return new FileSink(this.#path, options?.highWaterMark);
	}

	/** Overwrite the file with `data`, matching `BunFile.write()`. */
	async write(data: WriteData): Promise<number> {
		return await write(this, data);
	}

	async delete(): Promise<void> {
		await fsp.rm(this.#path, { force: true });
	}

	/** `stat(2)` for this file, matching `BunFile.stat()`. */
	async stat(): Promise<fs.Stats> {
		return await fsp.stat(this.#path);
	}

	toString(): string {
		return `file://${this.#path.replaceAll("\\", "/")}`;
	}

	async #read(): Promise<Buffer> {
		if (this.#start === undefined && this.#end === undefined) return await fsp.readFile(this.#path);
		const handle = await fsp.open(this.#path, "r");
		try {
			const stat = await handle.stat();
			const start = Math.min(this.#start ?? 0, stat.size);
			const length = Math.max(0, Math.min(this.#end ?? stat.size, stat.size) - start);
			const buffer = Buffer.allocUnsafe(length);
			if (length > 0) await handle.read(buffer, 0, length, start);
			return buffer;
		} finally {
			await handle.close();
		}
	}
}

const MIME_BY_EXTENSION: Record<string, string> = {
	".bin": "application/octet-stream",
	".css": "text/css",
	".gif": "image/gif",
	".html": "text/html",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript",
	".json": "application/json",
	".jsonl": "application/x-ndjson",
	".md": "text/markdown",
	".mjs": "text/javascript",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".toml": "application/toml",
	".ts": "text/typescript",
	".txt": "text/plain",
	".wasm": "application/wasm",
	".webp": "image/webp",
	".xml": "application/xml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
	".zip": "application/zip",
};

export function mimeTypeForPath(filePath: string): string {
	return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Create a lazy file handle. */
export function file(target: string | URL | NodeFile): NodeFile {
	return target instanceof NodeFile ? target : new NodeFile(target);
}

/** Destination accepted by {@link write} besides a path. */
export interface WriteSink {
	write(chunk: Uint8Array | string): unknown;
	readonly fd?: number;
}

/** `process.stdout` as a `bun.write` destination. */
export const stdout: WriteSink = process.stdout;

/** `process.stderr` as a `bun.write` destination. */
export const stderr: WriteSink = process.stderr;

/** Lazy `stdin` handle matching the `bun.stdin` file API (`text()`, `stream()`, …). */
export const stdin = {
	fd: 0,
	async text(): Promise<string> {
		return (await stdin.arrayBuffer()).toString("utf8");
	},
	async json<T = unknown>(): Promise<T> {
		return JSON.parse(await stdin.text()) as T;
	},
	async arrayBuffer(): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		return Buffer.concat(chunks);
	},
	async bytes(): Promise<Uint8Array> {
		return new Uint8Array(await stdin.arrayBuffer());
	},
	stream(): ReadableStream<Uint8Array> {
		return Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
	},
};

export type WriteData =
	| string
	| NodeFile
	| ArrayBuffer
	| ArrayBufferView
	| Blob
	| Response
	| ReadableStream<Uint8Array>
	| null
	| undefined;

/** Options accepted by the `bun.write`-shaped {@link write}. */
export interface WriteOptions {
	/** Create the destination's parent directories (Bun's `createPath`). */
	createPath?: boolean;
}

/**
 * Write `data` to `destination` and resolve with the byte count.
 *
 * `destination` may be a path, URL, `NodeFile`, or a writable sink such as
 * {@link stdout}. Mirrors `bun.write`, including `Response` bodies.
 */
export async function write(
	destination: string | URL | NodeFile | WriteSink,
	data: WriteData,
	options: WriteOptions = {},
): Promise<number> {
	const target = destination instanceof NodeFile ? destination.name : destination;
	const bytes = await materialize(data);
	if (typeof target === "string") {
		// Bun's `write` creates missing parent directories by default.
		if (options.createPath !== false) await fsp.mkdir(path.dirname(target), { recursive: true });
		await fsp.writeFile(target, bytes);
		return bytes.byteLength;
	}
	if (target instanceof URL) {
		const filePath = fileURLToPath(target);
		if (options.createPath !== false) await fsp.mkdir(path.dirname(filePath), { recursive: true });
		await fsp.writeFile(filePath, bytes);
		return bytes.byteLength;
	}
	target.write(bytes);
	return bytes.byteLength;
}

async function materialize(data: WriteData): Promise<Buffer> {
	if (data === null || data === undefined) return Buffer.alloc(0);
	if (typeof data === "string") return Buffer.from(data, "utf8");
	if (data instanceof NodeFile) return Buffer.from(await data.arrayBuffer());
	if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
	if (data instanceof Response) return Buffer.from(await data.arrayBuffer());
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (typeof (data as ReadableStream<Uint8Array>).getReader === "function") {
		const chunks: Buffer[] = [];
		const reader = (data as ReadableStream<Uint8Array>).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks);
	}
	throw new TypeError("write(): unsupported data type");
}

// ---------------------------------------------------------------------------
// Environment / process
// ---------------------------------------------------------------------------

/** `process.env` under Bun's name. Writes mutate the real environment. */
export const env: Record<string, string> = process.env as Record<string, string>;

/** `process.argv` under Bun's name. */
export const argv: string[] = process.argv;

/**
 * Absolute path of the main module. A compiled standalone binary's `argv[1]`
 * is the runtime's virtual root, not a spawnable file; its `execPath` is the
 * executable that must be re-entered for worker dispatch.
 */
export const main: string = (() => {
	const url = import.meta.url;
	const compiled =
		Boolean(process.env.PI_COMPILED) || url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
	return compiled ? path.resolve(process.execPath) : path.resolve(process.argv[1] ?? process.cwd());
})();

export const isMainThreadBun = isMainThread;

/** Node version string; `bun.version` had the same shape. */
export const version: string = process.versions.node;

/** Resolve after `ms` milliseconds; resolves with `value` when provided. */
export function sleep<T = undefined>(ms: number, value?: T): Promise<T> {
	const { promise, resolve } = Promise.withResolvers<T>();
	// Keep the timer referenced: Bun's `sleep` keeps the process alive, and
	// unref'ing here drains the event loop inside poll loops that only await it.
	setTimeout(() => resolve(value as T), ms);
	return promise;
}

/** Block the thread for `ms` milliseconds. */
export function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * Monotonic nanoseconds since an arbitrary origin.
 *
 * `hrtime.bigint()` is a `bigint`; converting to `number` mirrors Bun's return
 * type and stays exact for process lifetimes below ~104 days.
 */
export function nanoseconds(): number {
	return Number(process.hrtime.bigint());
}

/** Force a garbage collection when Node runs with `--expose-gc`; no-op otherwise. */
export function gc(_force = false): void {
	const scope = globalThis as { gc?: () => void };
	scope.gc?.();
}

/**
 * Today's V8 heap snapshot as JSON text, the shape Bun returned for
 * `generateHeapSnapshot("v8")`. `v8.writeHeapSnapshot` only writes to a file,
 * so the snapshot goes to a scratch file that is read back and removed.
 */
export function generateHeapSnapshot(format: "v8" = "v8"): string {
	if (format !== "v8") throw new Error(`Unsupported heap snapshot format: ${format}`);
	const filePath = path.join(tmpdir(), `omp-heap-${process.pid}-${Date.now().toString(36)}.heapsnapshot`);
	try {
		v8.writeHeapSnapshot(filePath);
		return fs.readFileSync(filePath, "utf8");
	} finally {
		fs.rmSync(filePath, { force: true });
	}
}

/** Inspect a value with `util.inspect`. */
export function inspect(value: unknown, options?: InspectOptions): string {
	return nodeInspect(value, options);
}

/**
 * Structural equality.
 *
 * Bun has a lenient and a strict variant; Node's `isDeepStrictEqual` is the
 * deterministic choice for both, and is what `strict: true` mapped to before.
 */
export function deepEquals<T>(a: T, b: T, _strict = false): boolean {
	return isDeepStrictEqual(a, b);
}

/** UUID v7 (time-ordered), as `bun.randomUUIDv7`. */
export function randomUUIDv7(): string {
	const bytes = randomBytes(16);
	const timestamp = BigInt(Date.now());
	for (let index = 0; index < 6; index++) {
		bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Random UUID v4. */
export const randomUUIDv4 = randomUUID;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(data: Uint8Array, seed = 0): number {
	let crc = (seed ^ 0xffffffff) >>> 0;
	for (let index = 0; index < data.length; index++) {
		crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (let index = 0; index < data.length; index++) {
		a = (a + data[index]) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

function toBytes(data: string | ArrayBuffer | ArrayBufferView): Buffer {
	if (typeof data === "string") return Buffer.from(data, "utf8");
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return Buffer.from(data);
}

/**
 * 64-bit non-cryptographic hash.
 *
 * Bun uses wyhash; Node has no builtin equivalent, so this derives the value
 * from SHA-256's first eight bytes. Values are stable across runs but do NOT
 * equal Bun's, so caches keyed by Bun's hash invalidate once on migration.
 */
function hash64(data: string | ArrayBuffer | ArrayBufferView, seed: number | bigint = 0): number {
	return Number(hash64Big(data, seed));
}

/** 64-bit hash as a `bigint`; Bun's `hash.xxHash64` used the wide form. */
function hash64Big(data: string | ArrayBuffer | ArrayBufferView, seed: number | bigint = 0): bigint {
	// Template coercion avoids the ambient `String` binding, which sandboxed
	// callers (and the snapshot-digest tests) may have replaced.
	const digest = createHash("sha256").update(toBytes(data)).update(`${seed}`).digest();
	return digest.readBigUInt64LE(0);
}

/** Rotate a uint32 left by `bits`. */
function rotl32(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function readU32Le(data: Uint8Array, offset: number): number {
	return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

const XXH32_PRIME1 = 0x9e3779b1;
const XXH32_PRIME2 = 0x85ebca77;
const XXH32_PRIME3 = 0xc2b2ae3d;
const XXH32_PRIME4 = 0x27d4eb2f;
const XXH32_PRIME5 = 0x165667b1;

/** Standard XXH32, matching Bun's `hash.xxHash32` (seed defaults to 0). */
function xxh32(data: Uint8Array, seed = 0): number {
	const length = data.length;
	let offset = 0;
	let accumulator: number;

	if (length >= 16) {
		let v1 = (seed + XXH32_PRIME1 + XXH32_PRIME2) >>> 0;
		let v2 = (seed + XXH32_PRIME2) >>> 0;
		let v3 = seed >>> 0;
		let v4 = (seed - XXH32_PRIME1) >>> 0;
		const limit = length - 16;
		do {
			v1 = xxh32Round(v1, readU32Le(data, offset));
			offset += 4;
			v2 = xxh32Round(v2, readU32Le(data, offset));
			offset += 4;
			v3 = xxh32Round(v3, readU32Le(data, offset));
			offset += 4;
			v4 = xxh32Round(v4, readU32Le(data, offset));
			offset += 4;
		} while (offset <= limit);
		accumulator = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
	} else {
		accumulator = (seed + XXH32_PRIME5) >>> 0;
	}

	accumulator = (accumulator + length) >>> 0;
	while (offset + 4 <= length) {
		accumulator = (accumulator + Math.imul(readU32Le(data, offset), XXH32_PRIME3)) >>> 0;
		accumulator = Math.imul(rotl32(accumulator, 17), XXH32_PRIME4) >>> 0;
		offset += 4;
	}
	while (offset < length) {
		accumulator = (accumulator + Math.imul(data[offset], XXH32_PRIME5)) >>> 0;
		accumulator = Math.imul(rotl32(accumulator, 11), XXH32_PRIME1) >>> 0;
		offset++;
	}
	accumulator ^= accumulator >>> 15;
	accumulator = Math.imul(accumulator, XXH32_PRIME2) >>> 0;
	accumulator ^= accumulator >>> 13;
	accumulator = Math.imul(accumulator, XXH32_PRIME3) >>> 0;
	accumulator ^= accumulator >>> 16;
	return accumulator >>> 0;
}

function xxh32Round(accumulator: number, input: number): number {
	accumulator = (accumulator + Math.imul(input, XXH32_PRIME2)) >>> 0;
	accumulator = rotl32(accumulator, 13);
	return Math.imul(accumulator, XXH32_PRIME1) >>> 0;
}

export const hash = Object.assign(
	(data: string | ArrayBuffer | ArrayBufferView, seed?: number | bigint) => hash64(data, seed),
	{
		wyhash: (data: string | ArrayBuffer | ArrayBufferView, seed?: number | bigint) => hash64Big(data, seed),
		adler32: (data: string | ArrayBuffer | ArrayBufferView) => adler32(toBytes(data)),
		crc32: (data: string | ArrayBuffer | ArrayBufferView, seed?: number) => crc32(toBytes(data), seed),
		xxHash32: (data: string | ArrayBuffer | ArrayBufferView, seed?: number | bigint) =>
			xxh32(toBytes(data), seed === undefined ? 0 : Number(seed)),
		xxHash64: (data: string | ArrayBuffer | ArrayBufferView, seed?: number | bigint) => hash64Big(data, seed),
		murmur64v2: (data: string | ArrayBuffer | ArrayBufferView, seed?: number | bigint) => hash64Big(data, seed),
	},
);

type HashEncoding = "hex" | "base64" | "base64url" | "buffer" | Uint8Array;

function encodeDigest(buffer: Buffer, encoding: HashEncoding): string | Uint8Array {
	if (encoding instanceof Uint8Array) {
		encoding.set(buffer.subarray(0, encoding.length));
		return encoding;
	}
	if (encoding === "buffer") return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	return buffer.toString(encoding);
}

/**
 * Incremental hash, matching `new bun.CryptoHasher(algorithm, key?)`.
 *
 * A supplied key switches to HMAC, which is what Bun's second argument did; the
 * secrets module depends on that keyed behavior.
 */
export class CryptoHasher {
	readonly #algorithm: string;
	readonly #key: Buffer | null;
	readonly #chunks: Buffer[] = [];
	#digested = false;

	constructor(algorithm: string = "sha256", key?: string | ArrayBuffer | ArrayBufferView) {
		this.#algorithm = algorithm;
		this.#key = key === undefined ? null : Buffer.from(toBytes(key));
	}

	update(data: string | ArrayBuffer | ArrayBufferView): this {
		this.#chunks.push(Buffer.from(toBytes(data)));
		return this;
	}

	/** Digest bytes by default, matching Bun; pass an encoding for text output. */
	digest(): Uint8Array;
	digest(encoding: "hex" | "base64" | "base64url"): string;
	digest(encoding: "buffer"): Uint8Array;
	digest(encoding: HashEncoding): string | Uint8Array;
	digest(encoding: HashEncoding = "buffer"): string | Uint8Array {
		if (this.#digested) throw new Error("CryptoHasher: digest() called twice");
		this.#digested = true;
		const state = this.#key ? createHmac(this.#algorithm, this.#key) : createHash(this.#algorithm);
		for (const chunk of this.#chunks) state.update(chunk);
		return encodeDigest(state.digest(), encoding);
	}

	copy(): CryptoHasher {
		const clone = new CryptoHasher(this.#algorithm, this.#key ?? undefined);
		for (const chunk of this.#chunks) clone.#chunks.push(chunk);
		return clone;
	}
}

/** One-shot digest helper surface shared by `bun.SHA256` / `bun.SHA1` / …. */
export interface HashAlgorithm {
	hash(data: string | ArrayBuffer | ArrayBufferView): Uint8Array;
	hash(data: string | ArrayBuffer | ArrayBufferView, encoding: "hex" | "base64" | "base64url"): string;
	hash(data: string | ArrayBuffer | ArrayBufferView, encoding: "buffer"): Uint8Array;
	hash(data: string | ArrayBuffer | ArrayBufferView, encoding: Uint8Array): Uint8Array;
	update(data: string | ArrayBuffer | ArrayBufferView): HashAlgorithm;
	digest(): Uint8Array;
	digest(encoding: "hex" | "base64" | "base64url"): string;
	digest(encoding: "buffer"): Uint8Array;
}

function createHashAlgorithm(algorithm: string) {
	// Bun's `SHA256.hash(data)` returns bytes by default; only an explicit encoding yields text.
	const digest = (
		data: string | ArrayBuffer | ArrayBufferView,
		encoding: HashEncoding = "buffer",
	): string | Uint8Array => encodeDigest(createHash(algorithm).update(toBytes(data)).digest(), encoding);

	class Algorithm {
		static readonly hash = digest as HashAlgorithm["hash"];
		readonly #hasher = new CryptoHasher(algorithm);
		update(data: string | ArrayBuffer | ArrayBufferView): this {
			this.#hasher.update(data);
			return this;
		}
		digest(): Uint8Array;
		digest(encoding: "hex" | "base64" | "base64url"): string;
		digest(encoding: "buffer"): Uint8Array;
		digest(encoding: HashEncoding = "buffer"): string | Uint8Array {
			return this.#hasher.digest(encoding);
		}
	}

	return Algorithm;
}

export const SHA256 = createHashAlgorithm("sha256");
export const SHA1 = createHashAlgorithm("sha1");
export const SHA384 = createHashAlgorithm("sha384");
export const SHA512 = createHashAlgorithm("sha512");

/** `bun.sha(input, encoding)` — SHA-1 digest of `input`. */
export function sha(data: string | ArrayBuffer | ArrayBufferView, encoding: HashEncoding = "hex"): string | Uint8Array {
	return encodeDigest(createHash("sha1").update(toBytes(data)).digest(), encoding);
}

/** `sha` overloads preserved through the `bun` namespace object. */
export interface ShaFunction {
	(data: string | ArrayBuffer | ArrayBufferView): string;
	(data: string | ArrayBuffer | ArrayBufferView, encoding: "hex" | "base64" | "base64url"): string;
	(data: string | ArrayBuffer | ArrayBufferView, encoding: "buffer"): Uint8Array;
}

/** Constant-time byte comparison. */
export function timingSafeEqualBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
	if (a.byteLength !== b.byteLength) return false;
	return timingSafeEqual(
		Buffer.from(a.buffer, a.byteOffset, a.byteLength),
		Buffer.from(b.buffer, b.byteOffset, b.byteLength),
	);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Remove ANSI escape sequences (CSI/OSC/…), as `bun.stripANSI`.
 *
 * `node:util`'s `stripVTControlCharacters` cannot be used here: its
 * BEL-terminated branch swallows text between a CSI sequence and a BEL, so
 * `"clear\x1b[2Jscreen\x07bell"` loses `screen`. Parse the sequences instead
 * so only the escape bytes are dropped.
 */
export function stripANSI(input: string): string {
	if (input.indexOf("\u001B") === -1 && input.indexOf("\u009B") === -1) return input;
	let out = "";
	let i = 0;
	const length = input.length;
	while (i < length) {
		const char = input[i];
		if (char === "\u001B") {
			const next = input.charCodeAt(i + 1);
			if (Number.isNaN(next)) {
				i += 1;
				continue;
			}
			if (next === 0x5b /* [ */) {
				i = scanControlSequence(input, i + 2);
				continue;
			}
			if (next === 0x5d /* ] */) {
				i = skipStringTerminated(input, i + 2);
				continue;
			}
			if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f /* P X ^ _ */) {
				i = skipStringTerminated(input, i + 2);
				continue;
			}
			if (next >= 0x20 && next <= 0x2f) {
				i += 2;
				while (i < length) {
					const code = input.charCodeAt(i);
					if (code >= 0x20 && code <= 0x2f) {
						i += 1;
						continue;
					}
					if (code >= 0x30 && code <= 0x7e) i += 1;
					break;
				}
				continue;
			}
			// Two-byte escape (final byte in 0x30–0x7E) or a lone ESC.
			i += 2;
			continue;
		}
		if (char === "\u009B") {
			i = scanControlSequence(input, i + 1);
			continue;
		}
		out += char;
		i += 1;
	}
	return out;
}

/** Skip a CSI sequence body, returning the index just past its final byte. */
function scanControlSequence(input: string, start: number): number {
	let i = start;
	while (i < input.length) {
		const code = input.charCodeAt(i);
		i += 1;
		if (code >= 0x40 && code <= 0x7e) break;
	}
	return i;
}

/** Skip an OSC/DCS-style string up to BEL or ST (`ESC \`), returning the index past it. */
function skipStringTerminated(input: string, start: number): number {
	let i = start;
	while (i < input.length) {
		const char = input[i];
		if (char === "\u0007") return i + 1;
		if (char === "\u001B" && input[i + 1] === "\\") return i + 2;
		i += 1;
	}
	return i;
}

/** Options accepted by `Bun.stringWidth` / `string-width`. */
export interface StringWidthOptions {
	/** Count ANSI escape sequences as part of the measured string. */
	countAnsiEscapeCodes?: boolean;
	/** Treat East Asian ambiguous-width characters as one cell (default: wide). */
	ambiguousIsNarrow?: boolean;
}

/**
 * Terminal display width in cells, matching `bun.stringWidth`.
 *
 * Escape sequences are stripped by default; pass
 * `{ countAnsiEscapeCodes: true }` to measure them as literal characters.
 */
export function stringWidth(input: string, options: StringWidthOptions = {}): number {
	return measureWidth(input, {
		countAnsiEscapeCodes: options.countAnsiEscapeCodes ?? false,
		ambiguousIsNarrow: options.ambiguousIsNarrow,
	});
}

/** Word-wrap to `width` cells while preserving ANSI sequences. */
export function wrapAnsi(
	input: string,
	width: number,
	options?: { hard?: boolean; wordWrap?: boolean; trim?: boolean },
): string {
	return wrapToWidth(input, width, options);
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

export function gzipSync(data: Uint8Array | string): Uint8Array {
	return zlib.gzipSync(typeof data === "string" ? Buffer.from(data) : data);
}

export function gunzipSync(data: Uint8Array): Uint8Array {
	return zlib.gunzipSync(data);
}

export function inflateSync(data: Uint8Array): Uint8Array {
	return zlib.inflateSync(data);
}

export function deflateSync(data: Uint8Array | string): Uint8Array {
	return zlib.deflateSync(typeof data === "string" ? Buffer.from(data) : data);
}

export function zstdCompressSync(data: Uint8Array | string): Uint8Array {
	return zlib.zstdCompressSync(typeof data === "string" ? Buffer.from(data) : data);
}

export function zstdDecompressSync(data: Uint8Array): Uint8Array {
	return zlib.zstdDecompressSync(data);
}

export function zstdCompress(data: Uint8Array | string, options?: { level?: number }): Promise<Uint8Array> {
	const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
	const input = typeof data === "string" ? Buffer.from(data) : data;
	const params =
		options?.level === undefined ? {} : { params: { [zlib.constants.ZSTD_c_compressionLevel]: options.level } };
	zlib.zstdCompress(input, params, (error, result) => {
		if (error) reject(error);
		else resolve(result);
	});
	return promise;
}

export function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
	const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
	zlib.zstdDecompress(data, (error, result) => {
		if (error) reject(error);
		else resolve(result);
	});
	return promise;
}

// ---------------------------------------------------------------------------
// Module resolution / executables
// ---------------------------------------------------------------------------

/**
 * Resolve `specifier` the way a module inside `parent` would.
 *
 * `parent` is a directory (Bun's contract) or a module path.
 */
export function resolveSync(specifier: string, parent?: string): string {
	const base = parent ?? process.cwd();
	let isDirectory = false;
	try {
		isDirectory = fs.statSync(base).isDirectory();
	} catch {
		isDirectory = false;
	}
	const dir = isDirectory ? base : path.dirname(base);
	try {
		return createRequire(path.join(dir, "__omp_resolve__.cjs")).resolve(specifier);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
		// Packages that only publish an `import` condition (the workspace
		// packages do) are invisible to `require.resolve`. Resolve their exports
		// map the way Node's ESM resolver would.
		return resolveImportConditionSpecifier(specifier, dir);
	}
}

/** Pick the first string target from an exports condition object. */
function pickExportsCondition(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return null;
	const conditions = value as Record<string, unknown>;
	for (const condition of ["import", "node", "default"]) {
		const target = conditions[condition];
		if (typeof target === "string") return target;
	}
	return null;
}

/** Resolve `key` against an exports map, including `*` patterns. */
function resolveExportsTarget(exportsField: unknown, key: string): string | null {
	if (typeof exportsField === "string") return key === "." ? exportsField : null;
	if (!exportsField || typeof exportsField !== "object") return null;
	const map = exportsField as Record<string, unknown>;
	const keys = Object.keys(map);
	if (keys.length === 0 || keys.every(entry => !entry.startsWith("."))) {
		return key === "." ? pickExportsCondition(map) : null;
	}
	const exact = map[key];
	const exactTarget = pickExportsCondition(exact);
	if (exactTarget) return exactTarget;
	// Node picks the most specific matching pattern, not the first declared one:
	// `./oauth/*` must beat `./*` for `./oauth/anthropic`.
	const matches: Array<{ prefixLength: number; patternLength: number; value: unknown; matched: string }> = [];
	for (const [pattern, value] of Object.entries(map)) {
		const star = pattern.indexOf("*");
		if (star === -1) continue;
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
		matches.push({
			prefixLength: prefix.length,
			patternLength: pattern.length,
			value,
			matched: key.slice(prefix.length, key.length - suffix.length),
		});
	}
	matches.sort((left, right) => right.prefixLength - left.prefixLength || right.patternLength - left.patternLength);
	for (const match of matches) {
		const target = pickExportsCondition(match.value);
		if (target) return target.replaceAll("*", match.matched);
	}
	return null;
}

/**
 * Resolve a package specifier through an `import`-only `exports` map.
 *
 * `require.resolve` cannot see such entries, but the workspace packages and
 * legacy Pi extensions target the ESM condition.
 */
function resolveImportConditionSpecifier(specifier: string, dir: string): string {
	const segments = specifier.split("/");
	const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
	const subpath = specifier.slice(packageName.length + 1);
	let current = path.resolve(dir);
	for (;;) {
		// Node resolves a package's own name through its manifest before
		// consulting node_modules (self-reference). Workspace packages rely on
		// that: the coding-agent is not installed into its own node_modules, so
		// `@oh-my-pi/pi-coding-agent/config/registry` only resolves from here.
		const ownManifestPath = path.join(current, "package.json");
		const nestedManifestPath = path.join(current, "node_modules", packageName, "package.json");
		for (const manifestPath of [ownManifestPath, nestedManifestPath]) {
			if (!fs.existsSync(manifestPath)) continue;
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { exports?: unknown; name?: string };
			if (manifestPath === ownManifestPath && manifest.name !== packageName) continue;
			const target = resolveExportsTarget(manifest.exports, subpath ? `./${subpath}` : ".");
			if (target) return path.resolve(path.dirname(manifestPath), target);
		}
		const parentDir = path.dirname(current);
		if (parentDir === current) break;
		current = parentDir;
	}
	throw new Error(`Cannot resolve package "${packageName}" from "${dir}"`);
}

export { fileURLToPath, pathToFileURL };

/** Whether `moduleUrl` is the process entry module (`isMainModule(import.meta.url)`). */
export function isMainModule(moduleUrl: string): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return pathToFileURL(path.resolve(entry)).href === new URL(moduleUrl).href;
	} catch {
		return false;
	}
}

/** Options for {@link which}. */
export interface WhichOptions {
	cwd?: string;
	PATH?: string;
	requireAbsolutePaths?: boolean;
}

/** Locate an executable on `PATH`, matching `bun.which`. */
export function which(command: string, options?: WhichOptions): string | null {
	if (path.isAbsolute(command)) {
		return isExecutable(command) ? command : null;
	}
	const rawPath = options?.PATH ?? process.env.PATH ?? "";
	const cwd = options?.cwd ?? process.cwd();
	const extensions =
		process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
	for (const entry of rawPath.split(path.delimiter)) {
		if (!entry) continue;
		if (options?.requireAbsolutePaths && !path.isAbsolute(entry)) continue;
		const directory = path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
		for (const extension of extensions) {
			const candidate = path.join(directory, process.platform === "win32" ? command + extension : command);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return null;
}

function isExecutable(candidate: string): boolean {
	try {
		const stat = fs.statSync(candidate);
		if (!stat.isFile()) return false;
		if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

export interface GlobScanOptions {
	cwd?: string;
	absolute?: boolean;
	dot?: boolean;
	followSymlinks?: boolean;
	onlyFiles?: boolean;
	throwErrorOnBrokenSymlink?: boolean;
}

/** `Glob` backed by Node's `fs.glob` / `path.matchesGlob`. */
export class Glob {
	readonly #pattern: string;

	constructor(pattern: string) {
		this.#pattern = pattern;
	}

	async *scan(options: GlobScanOptions | string = {}): AsyncGenerator<string> {
		const resolved = typeof options === "string" ? { cwd: options } : options;
		const cwd = resolved.cwd ?? process.cwd();
		for await (const match of fsp.glob(this.#pattern, { cwd, withFileTypes: false })) {
			const value = String(match);
			const absolute = path.isAbsolute(value) ? value : path.join(cwd, value);
			if (!(await this.#accept(absolute, resolved))) continue;
			yield resolved.absolute ? absolute : value;
		}
	}

	*scanSync(options: GlobScanOptions | string = {}): Generator<string> {
		const resolved = typeof options === "string" ? { cwd: options } : options;
		const cwd = resolved.cwd ?? process.cwd();
		for (const match of fs.globSync(this.#pattern, { cwd, withFileTypes: false })) {
			const value = String(match);
			const absolute = path.isAbsolute(value) ? value : path.join(cwd, value);
			if (!this.#acceptSync(absolute, resolved)) continue;
			yield resolved.absolute ? absolute : value;
		}
	}

	match(candidate: string): boolean {
		return path.matchesGlob(candidate, this.#pattern);
	}

	async #accept(absolute: string, options: GlobScanOptions): Promise<boolean> {
		if (options.onlyFiles === undefined && options.followSymlinks === undefined) return true;
		try {
			const stat = await fsp.stat(absolute);
			return !options.onlyFiles || stat.isFile();
		} catch {
			return options.throwErrorOnBrokenSymlink === true;
		}
	}

	#acceptSync(absolute: string, options: GlobScanOptions): boolean {
		if (options.onlyFiles === undefined && options.followSymlinks === undefined) return true;
		try {
			const stat = fs.statSync(absolute);
			return !options.onlyFiles || stat.isFile();
		} catch {
			return options.throwErrorOnBrokenSymlink === true;
		}
	}
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

/** `bun.JSONL` — JSON Lines parse/stringify. */
export const JSONL = {
	parse(text: string): unknown[] {
		const values: unknown[] = [];
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			values.push(JSON.parse(line));
		}
		return values;
	},
	parseChunk(
		text: string | Uint8Array,
		offset = 0,
		length?: number,
	): { values: unknown[]; error: Error | null; read: number; done: boolean } {
		const source =
			typeof text === "string" ? Buffer.from(text) : Buffer.from(text.buffer, text.byteOffset, text.byteLength);
		const end = length === undefined ? source.length : Math.min(source.length, offset + length);
		const slice = source.subarray(offset, end);
		const values: unknown[] = [];
		const isWhitespace = (byte: number): boolean => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
		let cursor = 0;
		while (cursor < slice.length) {
			while (cursor < slice.length && isWhitespace(slice[cursor]!)) cursor++;
			if (cursor >= slice.length) break;
			const valueStart = cursor;
			const first = slice[cursor]!;
			let incomplete = false;
			if (first === 0x7b || first === 0x5b) {
				// Objects/arrays may span newlines: scan the structure, not lines.
				let depth = 0;
				let inString = false;
				let escaped = false;
				let closed = false;
				for (; cursor < slice.length; cursor++) {
					const byte = slice[cursor]!;
					if (inString) {
						if (escaped) escaped = false;
						else if (byte === 0x5c) escaped = true;
						else if (byte === 0x22) inString = false;
						continue;
					}
					if (byte === 0x22) inString = true;
					else if (byte === 0x7b || byte === 0x5b) depth++;
					else if (byte === 0x7d || byte === 0x5d) {
						// A stray closer is left for JSON.parse to reject.
						if (depth === 0) {
							cursor++;
							closed = true;
							break;
						}
						depth--;
						if (depth === 0) {
							cursor++;
							closed = true;
							break;
						}
					}
				}
				incomplete = !closed;
			} else if (first === 0x22) {
				let escaped = false;
				let closed = false;
				for (cursor++; cursor < slice.length; cursor++) {
					const byte = slice[cursor]!;
					if (escaped) escaped = false;
					else if (byte === 0x5c) escaped = true;
					else if (byte === 0x22) {
						cursor++;
						closed = true;
						break;
					}
				}
				incomplete = !closed;
			} else {
				while (cursor < slice.length && !isWhitespace(slice[cursor]!)) cursor++;
			}
			const candidate = slice.subarray(valueStart, cursor).toString("utf8");
			try {
				values.push(JSON.parse(candidate));
			} catch (error) {
				// A value that merely ends with the buffer is incomplete, not malformed:
				// a JSON error position before the buffer end proves real syntax damage.
				const position = /at position (\d+)/.exec(error instanceof Error ? error.message : "")?.[1];
				const truncated = incomplete && (position === undefined || Number(position) >= candidate.length);
				return {
					values,
					error: truncated ? null : (error as Error),
					read: offset + valueStart,
					done: false,
				};
			}
		}
		return { values, error: null, read: offset + cursor, done: true };
	},
	stringify(values: Iterable<unknown>): string {
		let out = "";
		for (const value of values) out += `${JSON.stringify(value)}\n`;
		return out;
	},
};

/** `bun.YAML` over the `yaml` package. */
export const YAML = {
	parse(text: string): unknown {
		return parseYaml(text);
	},
	stringify(value: unknown, _replacer?: unknown, space?: number | string): string {
		const indent = typeof space === "number" ? space : 2;
		return stringifyYaml(value, { indent });
	},
};

/** `bun.TOML` over `smol-toml`. */
export const TOML = {
	parse(text: string): Record<string, unknown> {
		return parseToml(text);
	},
	stringify(value: unknown): string {
		return stringifyToml(value as Record<string, unknown>);
	},
};

/** `bun.JSON5` over the `json5` package. */
export const JSON5 = {
	parse(text: string): unknown {
		return JSON5Module.parse(text);
	},
	stringify(value: unknown): string {
		return JSON5Module.stringify(value);
	},
};

/** `Bun.JSONC` over the `jsonc-parser` package. */
export const JSONC = {
	parse(text: string): unknown {
		return parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false });
	},
	stringify(value: unknown, space?: number): string {
		return JSON.stringify(value, null, space);
	},
};

/** `bun.semver` over the `semver` package. */
export const semver = {
	order(left: string, right: string): -1 | 0 | 1 {
		const result = semverModule.compare(left, right);
		return result < 0 ? -1 : result > 0 ? 1 : 0;
	},
	satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean {
		return semverModule.satisfies(version, range, options);
	},
	clean(version: string): string | null {
		return semverModule.clean(version);
	},
};

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export type ColorInput = string | number | { r: number; g: number; b: number; a?: number } | [number, number, number];
export type ColorFormat = "css" | "ansi" | "ansi-16" | "ansi-256" | "ansi-16m" | "number" | "hex" | "{rgb}" | "{rgba}";

const NAMED_COLORS: Record<string, [number, number, number]> = {
	black: [0, 0, 0],
	blue: [0, 0, 255],
	cyan: [0, 255, 255],
	gray: [128, 128, 128],
	green: [0, 128, 0],
	grey: [128, 128, 128],
	lime: [0, 255, 0],
	magenta: [255, 0, 255],
	maroon: [128, 0, 0],
	navy: [0, 0, 128],
	olive: [128, 128, 0],
	orange: [255, 165, 0],
	purple: [128, 0, 128],
	red: [255, 0, 0],
	silver: [192, 192, 192],
	teal: [0, 128, 128],
	transparent: [0, 0, 0],
	white: [255, 255, 255],
	yellow: [255, 255, 0],
};

function parseColor(input: ColorInput): [number, number, number, number] | null {
	if (typeof input === "number") {
		return [(input >> 16) & 0xff, (input >> 8) & 0xff, input & 0xff, 1];
	}
	if (Array.isArray(input)) return [input[0], input[1], input[2], 1];
	if (typeof input === "object") return [input.r, input.g, input.b, input.a ?? 1];
	const text = input.trim().toLowerCase();
	if (NAMED_COLORS[text]) return [...NAMED_COLORS[text], 1];
	const hex = text.replace(/^#/, "");
	if (/^[0-9a-f]{3,8}$/.test(hex)) {
		const expand = hex.length <= 4 ? [...hex].map(char => char + char).join("") : hex;
		const r = Number.parseInt(expand.slice(0, 2), 16);
		const g = Number.parseInt(expand.slice(2, 4), 16);
		const b = Number.parseInt(expand.slice(4, 6), 16);
		const a = expand.length >= 8 ? Number.parseInt(expand.slice(6, 8), 16) / 255 : 1;
		return [r, g, b, a];
	}
	const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
	if (rgb) {
		const parts = rgb[1]
			.split(/[,\s/]+/)
			.filter(Boolean)
			// CSS allows percent channels (`rgb(100% 0% 0%)`); Bun accepted them.
			.map(part => Number.parseFloat(part));
		if (parts.length >= 3) return [parts[0], parts[1], parts[2], parts[3] ?? 1];
	}
	const hsl = /^hsla?\(([^)]+)\)$/.exec(text);
	if (hsl) {
		const parts = hsl[1]
			.split(/[,\s/]+/)
			.filter(Boolean)
			// CSS spells saturation/lightness as percentages (`90%`), which Bun
			// accepted and callers (theme gradients) depend on.
			.map(part => Number.parseFloat(part));
		if (parts.length >= 3) {
			const [h, s, l] = [parts[0] / 360, parts[1] / 100, parts[2] / 100];
			const hue = (p: number, q: number, t: number): number => {
				let value = t;
				if (value < 0) value += 1;
				if (value > 1) value -= 1;
				if (value < 1 / 6) return p + (q - p) * 6 * value;
				if (value < 1 / 2) return q;
				if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
				return p;
			};
			const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
			const p = 2 * l - q;
			return [
				Math.round(hue(p, q, h + 1 / 3) * 255),
				Math.round(hue(p, q, h) * 255),
				Math.round(hue(p, q, h - 1 / 3) * 255),
				parts[3] ?? 1,
			];
		}
	}
	return null;
}

function toAnsi256(r: number, g: number, b: number): number {
	if (r === g && g === b) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return Math.round(((r - 8) / 247) * 24) + 232;
	}
	return 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
}

/** `bun.color` — parse CSS color input into the requested representation. */
export function color(
	input: ColorInput,
	format: ColorFormat,
): string | number | [number, number, number] | [number, number, number, number] | null {
	const parsed = parseColor(input);
	if (!parsed) return null;
	const [r, g, b, a] = parsed;
	switch (format) {
		case "css":
			return a === 1
				? `#${[r, g, b].map(value => value.toString(16).padStart(2, "0")).join("")}`
				: `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
		case "hex":
			return `#${[r, g, b].map(value => value.toString(16).padStart(2, "0")).join("")}`;
		case "number":
			return (r << 16) | (g << 8) | b;
		case "{rgb}":
			return [r, g, b];
		case "{rgba}":
			return [r, g, b, a];
		case "ansi":
		case "ansi-16":
			return `\x1b[${30 + (r > 128 ? 1 : 0) + (g > 128 ? 2 : 0) + (b > 128 ? 4 : 0)}m`;
		case "ansi-256":
			return `\x1b[38;5;${toAnsi256(r, g, b)}m`;
		case "ansi-16m":
			return `\x1b[38;2;${r};${g};${b}m`;
	}
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------

export type StdioOption = "pipe" | "inherit" | "ignore" | number | NodeFile | Uint8Array | null;

/** PTY attachment accepted by {@link spawn} (`Bun.Terminal`). */
export interface TerminalAttachment {
	readonly cols: number;
	readonly rows: number;
	spawn(command: string[], options: SpawnOptions): Subprocess;
	close(): void;
}

export interface SpawnOptionsBase {
	terminal?: TerminalAttachment;
	cwd?: string;
	detached?: boolean;
	/** Kill the child after this many milliseconds. */
	timeout?: number;
	/** Signal used to kill the child once {@link timeout} elapses. Defaults to `SIGKILL`. */
	killSignal?: NodeJS.Signals | number;
	env?: Record<string, string | undefined>;
	stdin?: StdioOption;
	stdout?: StdioOption;
	stderr?: StdioOption;
	/**
	 * Positional stdio slots (`stdin`, `stdout`, `stderr`, then extra fds).
	 * Individual `stdin`/`stdout`/`stderr` fields win when both are present.
	 */
	stdio?: StdioOption[];
	/**
	 * Receive messages from the child's IPC channel. Providing this appends an
	 * `"ipc"` slot after the stdio array, matching Bun's `bun.spawn`.
	 */
	ipc?: (message: unknown) => void;
	/**
	 * Child-process channel serialization. Bun also accepted `"advanced"`;
	 * Node supports both values since v13.2.
	 */
	serialization?: "json" | "advanced";
	onExit?: (subprocess: Subprocess, exitCode: number | null, signalCode: string | null, error?: Error) => void;
	signal?: AbortSignal;
	windowsHide?: boolean;
	windowsVerbatimArguments?: boolean;
	argv0?: string;
}

export interface SpawnOptions extends SpawnOptionsBase {}

/** Bun's `SpawnOptions` namespace exposed `WritableToIO`; the runtime object is the file sink. */
export namespace SpawnOptions {
	export type WritableToIO<In> = (FileSink | null) & { readonly __in?: In };
	export type ReadableToIO<Out> = (ReadableStream<Uint8Array> | null) & { readonly __out?: Out };
}

/** Bun's `Spawn` namespace carried the generic option bag used by `ptree`. */
export namespace Spawn {
	export type SpawnOptions<In = unknown, Out = unknown, Err = unknown> = Omit<
		SpawnOptionsBase,
		"stdin" | "stdout" | "stderr"
	> & {
		stdin?: In;
		stdout?: Out;
		stderr?: Err;
		timeout?: number;
	};
}

export interface SubprocessOutput {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	signalCode: string | null;
}

/** Buffered writer over `fs.createWriteStream`, shaped like `FileSink`. */
export class FileSink {
	readonly path: string | null;
	readonly #stream: Writable;
	readonly #extraWrites: number[] = [];
	#ended = false;

	constructor(target: string | Writable, highWaterMark?: number) {
		if (typeof target === "string") {
			this.path = target;
			this.#stream = fs.createWriteStream(target, highWaterMark === undefined ? undefined : { highWaterMark });
		} else {
			this.path = null;
			this.#stream = target;
		}
		// Bun's `FileSink.write` never throws when the peer (e.g. a child's stdin
		// after exit) is gone; Node reports EPIPE as an asynchronous `error`
		// event, which is fatal when the stream has no listener. `flush`/`end`
		// still surface write failures through their callbacks.
		this.#stream.on("error", () => {});
	}

	/** Queue bytes; returns the accepted byte count. */
	write(data: string | ArrayBufferView | ArrayBuffer): number {
		const bytes = toBytes(data as string | ArrayBuffer | ArrayBufferView);
		this.#stream.write(bytes);
		return bytes.byteLength;
	}

	start(): number {
		return this.#extraWrites.length;
	}

	async flush(): Promise<number> {
		// A child that already exited destroyed its stdin; there is nothing to
		// flush and Node would report ERR_STREAM_DESTROYED.
		if (this.#stream.destroyed) return 0;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#stream.write("", error => (error ? reject(error) : resolve()));
		await promise;
		return 0;
	}

	async end(): Promise<number> {
		if (this.#ended) return 0;
		this.#ended = true;
		if (this.#stream.destroyed || this.#stream.writableEnded) return 0;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#stream.end((error?: Error | null) => {
			// The child may have exited first, destroying the pipe. Its write side
			// is already closed, so ending it again is success, not a rejection.
			if (error && (error as NodeJS.ErrnoException).code !== "ERR_STREAM_DESTROYED") reject(error);
			else resolve();
		});
		await promise;
		return 0;
	}

	ref(): void {}
	unref(): void {}
}

/** Node-backed replacement for `Subprocess`. */
export class Subprocess<In = unknown, Out = unknown, Err = unknown> {
	declare readonly __io?: { stdin: In; stdout: Out; stderr: Err };
	/** PTY attachment this process was started with, when any. */
	declare terminal?: TerminalAttachment;
	readonly #child: ChildProcess;
	readonly #closeOnExit: number[];
	readonly #outputChunks: { stdout: Buffer[]; stderr: Buffer[] } | null;
	readonly #stdoutStream: ReadableStream<Uint8Array>;
	readonly #stderrStream: ReadableStream<Uint8Array>;
	readonly #exitedResult: Promise<number | null>;
	readonly #resolveExited: (code: number | null) => void;
	signalCode: NodeJS.Signals | null = null;

	constructor(child: ChildProcess, closeOnExit: number[], captureOutput: boolean, onExit?: SpawnOptions["onExit"]) {
		this.#child = child;
		this.#closeOnExit = closeOnExit;
		this.#outputChunks = captureOutput ? { stdout: [], stderr: [] } : null;
		// Wrap the pipes before the child can write: `Readable.toWeb` created after
		// the stream ended hands back an empty, disturbed stream, so a late
		// `new Response(child.stdout).text()` would lose the child's output.
		this.#stdoutStream = child.stdout
			? (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
			: new ReadableStream<Uint8Array>({ start: controller => controller.close() });
		this.#stderrStream = child.stderr
			? (Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>)
			: new ReadableStream<Uint8Array>({ start: controller => controller.close() });
		const deferred = Promise.withResolvers<number | null>();
		this.#resolveExited = deferred.resolve;
		this.#exitedResult = deferred.promise;
		if (captureOutput) {
			child.stdout?.on("data", (chunk: Buffer) => this.#outputChunks?.stdout.push(Buffer.from(chunk)));
			child.stderr?.on("data", (chunk: Buffer) => this.#outputChunks?.stderr.push(Buffer.from(chunk)));
		}
		child.on("exit", (code, signal) => {
			this.signalCode = signal;
			for (const fd of this.#closeOnExit) {
				try {
					fs.closeSync(fd);
				} catch {}
			}
			// Bun's `exited` resolves a signal-terminated child as 128 + the
			// signal number (SIGTERM -> 143) instead of Node's null.
			deferred.resolve(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : null));
			onExit?.(this, code, signal);
		});
		child.on("error", error => {
			this.#resolveExited(null);
			onExit?.(this, null, null, error);
		});
	}

	get pid(): number {
		return this.#child.pid ?? -1;
	}

	/** Whether `kill()` has been signalled, matching Bun's `Subprocess.killed`. */
	get killed(): boolean {
		return this.#child.killed;
	}

	/** Exit code once the process ended, or `null` while running. */
	get exitCode(): number | null {
		return this.#child.exitCode;
	}

	#stdinSink: FileSink | null = null;

	/** Child stdin pipe; a discard sink when the child inherited its descriptor. */
	get stdin(): FileSink {
		if (this.#stdinSink) return this.#stdinSink;
		const writable =
			this.#child.stdin ??
			new Writable({
				write(_chunk, _encoding, callback) {
					callback();
				},
			});
		this.#stdinSink = new FileSink(writable);
		return this.#stdinSink;
	}

	/** stdout pipe; an already-closed stream when the child inherited its descriptor. */
	get stdout(): ReadableStream<Uint8Array> {
		return this.#stdoutStream;
	}

	/** stderr pipe; an already-closed stream when the child inherited its descriptor. */
	get stderr(): ReadableStream<Uint8Array> {
		return this.#stderrStream;
	}

	/** Exit code; a signal-terminated child resolves as 128 + the signal number, matching Bun. */
	get exited(): Promise<number> {
		return this.#exitedResult.then(code => code ?? 0);
	}

	/** Send one message over the child's IPC channel; false when the channel is closed. */
	send(message: unknown): boolean {
		if (!this.#child.connected) return false;
		return this.#child.send(message as Parameters<ChildProcess["send"]>[0]);
	}

	/** Close the child's IPC channel; a no-op when the child has none. */
	disconnect(): void {
		if (this.#child.connected) this.#child.disconnect();
	}

	kill(signal?: number | NodeJS.Signals): void {
		this.#child.kill(signal as NodeJS.Signals | undefined);
	}

	ref(): void {
		this.#child.ref();
	}

	unref(): void {
		this.#child.unref();
	}

	async output(): Promise<SubprocessOutput> {
		const exitCode = await this.#exitedResult;
		if (!this.#outputChunks) throw new Error("output() requires stdout/stderr to be piped");
		return {
			stdout: Buffer.concat(this.#outputChunks.stdout),
			stderr: Buffer.concat(this.#outputChunks.stderr),
			exitCode,
			signalCode: this.signalCode,
		};
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (this.#child.exitCode === null && this.#child.signalCode === null) this.kill();
		await this.#exitedResult;
	}
}

/** Resolve a `.cmd`/`.bat` shim that Windows cannot spawn directly. */
function resolveWindowsShim(command: string): string | null {
	if (path.isAbsolute(command)) return /\.(cmd|bat)$/i.test(command) ? command : null;
	const resolved = which(command);
	return resolved && /\.(cmd|bat)$/i.test(resolved) ? resolved : null;
}

/** Quote one argument for `cmd.exe`. */
function shellEscape(value: string): string {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
}

function normalizeCommand(command: string[] | string | { cmd: string[] }): string[] {
	if (typeof command === "string") return [command];
	if (Array.isArray(command)) return command;
	return command.cmd;
}

function resolveStdio(
	option: StdioOption | undefined,
	mode: "r" | "w",
	closeOnExit: number[],
): "pipe" | "inherit" | "ignore" | number {
	if (option === undefined || option === null) return option === null ? "ignore" : "pipe";
	if (typeof option === "string") return option;
	if (typeof option === "number") return option;
	if (!(option instanceof NodeFile)) return "pipe";
	const fd = fs.openSync(option.name, mode === "r" ? "r" : "w");
	closeOnExit.push(fd);
	return fd;
}

/** Spawn a child process; `bun.spawn` compatible surface over `child_process.spawn`. */
export function spawn(
	command: string[] | string | ({ cmd: string[] } & SpawnOptions),
	options: SpawnOptions = {},
): Subprocess {
	const merged: SpawnOptions =
		typeof command === "object" && !Array.isArray(command) ? { ...command, ...options } : options;
	const argv = normalizeCommand(command);
	if (merged.terminal) return merged.terminal.spawn(argv, merged);
	const closeOnExit: number[] = [];
	// A byte payload as `stdin` is piped and written before the process reads.
	const stdinPayload = merged.stdin instanceof Uint8Array ? merged.stdin : null;
	const ipc = merged.ipc;
	const stdioCount = Math.max(3, merged.stdio?.length ?? 0);
	const stdio: ("pipe" | "inherit" | "ignore" | number | "ipc")[] = [];
	for (let index = 0; index < stdioCount; index++) {
		const override =
			index === 0 ? merged.stdin : index === 1 ? merged.stdout : index === 2 ? merged.stderr : undefined;
		stdio.push(
			resolveStdio(override === undefined ? merged.stdio?.[index] : override, index === 0 ? "r" : "w", closeOnExit),
		);
	}
	if (stdinPayload) stdio[0] = "pipe";
	if (ipc) stdio.push("ipc");
	const captureOutput = stdio[1] === "pipe" && stdio[2] === "pipe";
	// Windows resolves `.cmd`/`.bat` shims (pnpm, npm, tsgo) only through a shell;
	// Node refuses to execute them directly.
	const windowsShim = process.platform === "win32" ? resolveWindowsShim(argv[0]) : null;
	const child = windowsShim
		? nodeSpawn(
				// Let Node hand the quoted command line to `cmd.exe`; spelling the
				// `/s /c` nesting ourselves loses a quote level.
				[windowsShim, ...argv.slice(1)].map(arg => shellEscape(arg)).join(" "),
				{
					shell: true,
					cwd: merged.cwd,
					env: merged.env as NodeJS.ProcessEnv | undefined,
					stdio,
					windowsHide: merged.windowsHide,
					windowsVerbatimArguments: merged.windowsVerbatimArguments,
					argv0: merged.argv0,
					signal: merged.signal,
					detached: merged.detached,
				},
			)
		: nodeSpawn(argv[0], argv.slice(1), {
				cwd: merged.cwd,
				env: merged.env as NodeJS.ProcessEnv | undefined,
				stdio,
				serialization: ipc ? merged.serialization : undefined,
				windowsHide: merged.windowsHide,
				windowsVerbatimArguments: merged.windowsVerbatimArguments,
				argv0: merged.argv0,
				signal: merged.signal,
				killSignal: merged.killSignal,
				detached: merged.detached,
			});
	if (ipc) child.on("message", message => ipc(message));
	if (stdinPayload)
		child.stdin?.end(Buffer.from(stdinPayload.buffer, stdinPayload.byteOffset, stdinPayload.byteLength));
	const subprocess = new Subprocess(child, closeOnExit, captureOutput, merged.onExit);
	if (merged.timeout !== undefined) {
		const timer = setTimeout(() => child.kill(merged.killSignal ?? "SIGKILL"), merged.timeout);
		timer.unref?.();
		child.once("exit", () => clearTimeout(timer));
	}
	return subprocess;
}

export interface SpawnSyncOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	stdin?: StdioOption;
	stdout?: StdioOption;
	stderr?: StdioOption;
	/** Positional stdio slots; individual fields win when both are present. */
	stdio?: StdioOption[];
	timeout?: number;
	/** Signal sent when `timeout` elapses (Node default: `SIGTERM`). */
	killSignal?: NodeJS.Signals;
	maxBuffer?: number;
	windowsHide?: boolean;
}

export interface SpawnSyncResult {
	pid: number;
	success: boolean;
	exitCode: number | null;
	signalCode: string | null;
	stdout: Buffer;
	stderr: Buffer;
}

/** Synchronous spawn; `bun.spawnSync` compatible surface. */
export function spawnSync(
	command: string[] | string | { cmd: string[] },
	options: SpawnSyncOptions = {},
): SpawnSyncResult {
	const argv = normalizeCommand(command);
	const stdioCount = Math.max(3, options.stdio?.length ?? 0);
	const stdio: ("pipe" | "inherit" | "ignore" | number)[] = [];
	for (let index = 0; index < stdioCount; index++) {
		const override =
			index === 0 ? options.stdin : index === 1 ? options.stdout : index === 2 ? options.stderr : undefined;
		const option = override === undefined ? options.stdio?.[index] : override;
		stdio.push(
			option === undefined
				? "pipe"
				: option === null
					? "ignore"
					: typeof option === "string" || typeof option === "number"
						? option
						: "pipe",
		);
	}
	const result = nodeSpawnSync(argv[0], argv.slice(1), {
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv | undefined,
		stdio,
		timeout: options.timeout,
		killSignal: options.killSignal,
		maxBuffer: options.maxBuffer,
		windowsHide: options.windowsHide,
	});
	const stdout = result.stdout ?? Buffer.alloc(0);
	const stderr = result.stderr ?? Buffer.alloc(0);
	return {
		pid: result.pid ?? -1,
		success: result.status === 0,
		exitCode: result.status ?? null,
		signalCode: result.signal ?? null,
		stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
		stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
	};
}

// ---------------------------------------------------------------------------
// Aggregated namespace
// ---------------------------------------------------------------------------

/** Start an HTTP(S) server; re-exported so tests can spy on `bun.serve`. */
export const serve = serveHttp;

/**
 * The Bun compatibility namespace, shared by every evaluation of this module.
 *
 * `bun` stands in for a runtime-global (`Bun`), and Bun has exactly one
 * namespace per process. Source-link installs evaluate this module through both
 * the bundler and Node's native loader; separate objects let a call site in one
 * copy miss runtime configuration (or a test spy) installed on the other. The
 * first evaluation publishes the canonical object.
 */
const BUN_NAMESPACE = Symbol.for("oh-my-pi.pi-utils.bun");

const bunNamespace = {
	serve,
	file,
	write,
	env,
	argv,
	main,
	isMainThread,
	version,
	sleep,
	sleepSync,
	nanoseconds,
	spawn,
	spawnSync,
	hash,
	CryptoHasher,
	SHA256,
	SHA1,
	SHA384,
	SHA512,
	sha: sha as ShaFunction,
	stripANSI,
	stringWidth,
	wrapAnsi,
	deepEquals,
	inspect,
	gc,
	generateHeapSnapshot,
	randomUUIDv7,
	randomUUIDv4,
	which,
	resolveSync,
	fileURLToPath,
	pathToFileURL,
	isMainModule,
	Glob,
	JSONL,
	YAML,
	TOML,
	JSON5,
	JSONC,
	semver,
	color,
	gzipSync,
	gunzipSync,
	inflateSync,
	deflateSync,
	zstdCompressSync,
	zstdDecompressSync,
	zstdCompress,
	zstdDecompress,
	stdin,
	stdout,
	stderr,
	timingSafeEqual: timingSafeEqualBytes,
};

export const bun: typeof bunNamespace = (() => {
	const existing = Reflect.get(globalThis, BUN_NAMESPACE) as typeof bunNamespace | undefined;
	if (existing) return existing;
	Reflect.set(globalThis, BUN_NAMESPACE, bunNamespace);
	return bunNamespace;
})();

/** Type of the {@link spawn} function. */
export type Spawn = typeof spawn;

export type BunFile = NodeFile;
export type BunFileSink = FileSink;
export type BunSubprocess = Subprocess;
