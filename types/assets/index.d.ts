declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.txt" {
	const content: string;
	export default content;
}

declare module "*.py" {
	const content: string;
	export default content;
}

declare module "*.rb" {
	const content: string;
	export default content;
}

declare module "*.jl" {
	const content: string;
	export default content;
}

declare module "*.lark" {
	const content: string;
	export default content;
}

declare module "*.sh" {
	const content: string;
	export default content;
}

declare module "*.applescript" {
	const content: string;
	export default content;
}

declare module "*.bdf" {
	const content: string;
	export default content;
}

// Session-export template assets imported as text (coding-agent src/export/html).
// No `*.html` declaration: bun-types claims that pattern as HTMLBundle, so the
// text import casts at the use site instead.
declare module "*.css" {
	const content: string;
	export default content;
}

declare module "*/template.js" {
	const content: string;
	export default content;
}

declare module "*.generated.js" {
	const content: string;
	export default content;
}

// axe-core's minified browser build, imported as text by the browser a11y audit
// (coding-agent src/tools/browser/a11y/audit.ts) and evaluated inside the page.
declare module "axe-core/axe.min.js" {
	const content: string;
	export default content;
}

declare namespace NodeJS {
	interface Process {
		/**
		 * Low-level process terminator used by the postmortem exit path. Node keeps
		 * it off the public typings but the primitive exists at runtime.
		 */
		reallyExit?(code?: number): never;
	}
}

/** Bun's global timer handle type; Node's equivalent. */
declare type Timer = NodeJS.Timeout;

/** DOM form value type, absent from the Node-only lib set. */
declare type FormDataEntryValue = string | File;

/** WebCrypto key type; @types/node only declares the value. */
declare type CryptoKey = import("node:crypto").webcrypto.CryptoKey;

declare module "*.html" {
	const content: string;
	export default content;
}

/** WebCrypto key-pair type; @types/node only declares the value. */
declare type CryptoKeyPair = import("node:crypto").webcrypto.CryptoKeyPair;

/** Bun's fetch accepted a unix-socket target through an extra init field. */
interface RequestInit {
	unix?: string;
}
