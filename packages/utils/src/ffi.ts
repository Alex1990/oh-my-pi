/**
 * `bun:ffi` replacement backed by Koffi.
 *
 * Call sites declared native signatures as Bun FFI descriptors
 * (`{ prctl: { args: [FFIType.i32, …], returns: FFIType.i32 } }`). This module
 * keeps that descriptor shape and forwards to Koffi's dynamic loader, which runs
 * on Node for Windows, macOS, and Linux.
 */
import { createRequire } from "node:module";
import type koffi from "koffi";

const require = createRequire(import.meta.url);
let koffiModule: typeof koffi | undefined;

/** Load the native binding on the first FFI call, not at module evaluation. */
function loadKoffi(): typeof koffi {
	koffiModule ??= require("koffi") as typeof koffi;
	return koffiModule;
}

/** Bun's primitive type tags, mapped to Koffi type names. */
export const FFIType = {
	i8: "int8_t",
	u8: "uint8_t",
	i16: "int16_t",
	u16: "uint16_t",
	i32: "int32_t",
	u32: "uint32_t",
	i64: "int64_t",
	u64: "uint64_t",
	f32: "float",
	f64: "double",
	bool: "bool",
	ptr: "void *",
	cstring: "char *",
	void: "void",
} as const;

export type FFITypeName = (typeof FFIType)[keyof typeof FFIType];

/** TypeScript type produced by each FFI type tag. */
type NativeType<T extends FFITypeName> = T extends
	| "int8_t"
	| "uint8_t"
	| "int16_t"
	| "uint16_t"
	| "int32_t"
	| "uint32_t"
	| "float"
	| "double"
	? number
	: T extends "int64_t" | "uint64_t"
		? bigint
		: T extends "bool"
			? boolean
			: T extends "char *"
				? string
				: unknown;

type NativeArgs<A extends readonly FFITypeName[]> = {
	[K in keyof A]: A[K] extends FFITypeName ? NativeType<A[K]> : never;
};

type NativeFunction<D extends FunctionDefinition> = (...args: NativeArgs<D["args"]>) => NativeType<D["returns"]>;

type Symbols<D extends Record<string, FunctionDefinition>> = { [K in keyof D]: NativeFunction<D[K]> };

export interface FunctionDefinition {
	args: readonly FFITypeName[];
	returns: FFITypeName;
}

export interface Library<D extends Record<string, FunctionDefinition> = Record<string, FunctionDefinition>> {
	readonly symbols: Symbols<D>;
	close(): void;
}

/**
 * Address of a typed-array view, matching `bun:ffi`'s `ptr()`.
 *
 * Koffi accepts typed arrays directly for `void *` parameters; wrapping them
 * keeps the pointer alive for the duration of the call.
 */
export function ptr(view: ArrayBufferView | null): unknown {
	if (view === null) return null;
	return loadKoffi().as(view, "void *");
}

/** NUL-terminated string read from a raw pointer, matching `bun:ffi`'s `CString`. */
export class CString {
	readonly #pointer: unknown;

	constructor(pointer: unknown) {
		this.#pointer = pointer;
	}

	toString(): string {
		return loadKoffi().decode(this.#pointer, "char *") as string;
	}
}

/** Load a shared library and bind each declared symbol. */
export function dlopen<const D extends Record<string, FunctionDefinition>>(
	libraryPath: string,
	definition: D,
): Library<D> {
	const library = loadKoffi().load(libraryPath);
	const symbols = {} as Symbols<D>;
	for (const [name, declaration] of Object.entries(definition)) {
		symbols[name as keyof D] = library.func(name, declaration.returns, [...declaration.args]) as Symbols<D>[keyof D];
	}
	return {
		symbols,
		close() {
			library.unload();
		},
	};
}
