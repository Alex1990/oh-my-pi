/**
 * `Bun.Image` replacement backed by sharp.
 *
 * Bun shipped an in-process image pipeline (`new Bun.Image(bytes).metadata()`,
 * `.resize()` / `.png()` / `.jpeg()` / `.webp()` / `.bytes()`). sharp provides
 * the same transformations on Node.
 *
 * sharp is an optional native dependency: it is loaded lazily through
 * `createRequire` so a package that never touches images still works when the
 * platform binary is unavailable.
 */
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Sharp } from "sharp";

type SharpFactory = (input: string | Buffer, options?: Record<string, unknown>) => Sharp;

let sharpModule: SharpFactory | null | undefined;

function loadSharp(): SharpFactory {
	if (sharpModule !== undefined) {
		if (sharpModule === null) throw new Error("Image: the optional `sharp` dependency is not installed");
		return sharpModule;
	}
	try {
		sharpModule = createRequire(import.meta.url)("sharp") as SharpFactory;
	} catch {
		sharpModule = null;
	}
	if (sharpModule === null) throw new Error("Image: the optional `sharp` dependency is not installed");
	return sharpModule;
}

export interface ImageMetadata {
	width: number;
	height: number;
	format: string;
	[key: string]: unknown;
}

export interface ResizeOptions {
	/** Resampling kernel; `"nearest"` maps to sharp's nearest-neighbour. */
	filter?: "nearest" | "bilinear" | "bicubic" | "lanczos3" | "mitchell";
	/** `fill` (default) stretches; other values keep the aspect ratio. */
	fit?: "fill" | "contain" | "cover" | "inside" | "outside";
}

const KERNEL_BY_FILTER = {
	nearest: "nearest",
	bilinear: "linear",
	bicubic: "cubic",
	lanczos3: "lanczos3",
	mitchell: "mitchell",
} as const satisfies Record<NonNullable<ResizeOptions["filter"]>, string>;

export interface EncodeOptions {
	quality?: number;
	lossless?: boolean;
}

/** PNG encoder options; `compressionLevel` is sharp's 0–9 deflate level. */
export interface PngOptions {
	compressionLevel?: number;
}

type ImageInput = string | Uint8Array | ArrayBuffer | Blob;

/** Decode-time limits applied before the pipeline reads pixel data. */
export interface ImageOptions {
	/**
	 * Reject images whose decoded pixel count exceeds this bound (sharp's
	 * `limitInputPixels`). Matches Bun's `new Bun.Image(bytes, { maxPixels })`.
	 */
	maxPixels?: number;
}

/** Chainable image pipeline, shaped like `Bun.Image`. */
export class Image {
	readonly #pipeline: Sharp;
	#format = "png";

	constructor(input: ImageInput, options: ImageOptions = {}) {
		const sharp = loadSharp();
		this.#pipeline = sharp(
			toSharpInput(input),
			options.maxPixels === undefined ? undefined : { limitInputPixels: options.maxPixels },
		);
	}

	async metadata(): Promise<ImageMetadata> {
		const metadata = await this.#pipeline.metadata();
		this.#format = metadata.format ?? this.#format;
		return {
			...metadata,
			width: metadata.width ?? 0,
			height: metadata.height ?? 0,
			format: metadata.format ?? "unknown",
		};
	}

	resize(width: number, height: number, options: ResizeOptions = {}): Image {
		this.#pipeline.resize(width, height, {
			fit: options.fit ?? "fill",
			kernel: KERNEL_BY_FILTER[options.filter ?? "lanczos3"],
		});
		return this;
	}

	png(options: PngOptions = {}): Image {
		this.#pipeline.png(
			options.compressionLevel === undefined ? undefined : { compressionLevel: options.compressionLevel },
		);
		this.#format = "png";
		return this;
	}

	jpeg(options: EncodeOptions = {}): Image {
		this.#pipeline.jpeg({ quality: options.quality ?? 80 });
		this.#format = "jpeg";
		return this;
	}

	webp(options: EncodeOptions = {}): Image {
		this.#pipeline.webp({ quality: options.quality ?? 80, lossless: options.lossless });
		this.#format = "webp";
		return this;
	}

	async bytes(): Promise<Uint8Array> {
		const buffer = await this.#pipeline.toBuffer();
		return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	}

	/** Encoded bytes as a Node `Buffer`, matching Bun's `Image.toBuffer()`. */
	async toBuffer(): Promise<Buffer> {
		const bytes = await this.bytes();
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	/** Base64 encoding of the encoded bytes. */
	async toBase64(): Promise<string> {
		return (await this.toBuffer()).toString("base64");
	}

	async blob(): Promise<Blob> {
		const bytes = await this.bytes();
		// DOM `BlobPart` requires an `ArrayBuffer`-backed view; sharp returns a
		// pooled Buffer slice whose buffer may be `ArrayBufferLike`.
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		return new Blob([buffer], { type: `image/${this.#format}` });
	}

	async write(destination: string): Promise<number> {
		const bytes = await this.bytes();
		await writeFile(destination, bytes);
		return bytes.byteLength;
	}
}

function toSharpInput(input: ImageInput): string | Buffer {
	if (typeof input === "string") return input;
	if (input instanceof ArrayBuffer) return Buffer.from(input);
	if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	throw new TypeError("Image: pass a path, Uint8Array, or ArrayBuffer; convert a Blob with `Buffer.from` first");
}

export namespace Image {
	/** Encoded image formats the pipeline can emit. */
	export type Format = "jpeg" | "png" | "webp" | "heic" | "avif" | "gif" | "tiff" | "bmp";
}
