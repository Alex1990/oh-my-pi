/**
 * `Bun.Cookie` / `Bun.CookieMap` replacements.
 *
 * Cookie parsing/serialization is small enough to implement directly; the API
 * mirrors Bun's `name`/`value`/attribute fields and `CookieMap`'s Map surface.
 */

type HeadersInit = Headers | Record<string, string> | [string, string][];

export interface CookieOptions {
	domain?: string;
	path?: string;
	expires?: Date | number;
	maxAge?: number;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: "strict" | "lax" | "none";
	partitioned?: boolean;
}

/** One HTTP cookie, matching Bun's `Cookie`. */
export class Cookie {
	name = "";
	value = "";
	domain?: string;
	path?: string;
	expires?: Date;
	maxAge?: number;
	secure = false;
	httpOnly = false;
	sameSite?: "strict" | "lax" | "none";
	partitioned = false;

	constructor(name?: string, value?: string, options: CookieOptions = {}) {
		if (name !== undefined) this.name = name;
		if (value !== undefined) this.value = value;
		this.#applyOptions(options);
	}

	#applyOptions(options: CookieOptions): void {
		this.domain = options.domain;
		this.path = options.path;
		this.expires = options.expires === undefined ? undefined : new Date(options.expires);
		this.maxAge = options.maxAge;
		this.secure = options.secure ?? false;
		this.httpOnly = options.httpOnly ?? false;
		this.sameSite = options.sameSite;
		this.partitioned = options.partitioned ?? false;
	}

	static from(name: string, value: string, options?: CookieOptions): Cookie {
		return new Cookie(name, value, options);
	}

	/** Parse a `Cookie:` or `Set-Cookie:` header value. */
	static parse(source: string): Cookie {
		const parts = source.split(";");
		const [first, ...attributes] = parts;
		const equals = first.indexOf("=");
		const cookie =
			equals === -1
				? new Cookie("", first.trim())
				: new Cookie(first.slice(0, equals).trim(), first.slice(equals + 1).trim());
		for (const attribute of attributes) {
			const separator = attribute.indexOf("=");
			const key = (separator === -1 ? attribute : attribute.slice(0, separator)).trim().toLowerCase();
			const value = separator === -1 ? "" : attribute.slice(separator + 1).trim();
			switch (key) {
				case "domain":
					cookie.domain = value;
					break;
				case "path":
					cookie.path = value;
					break;
				case "expires":
					cookie.expires = new Date(value);
					break;
				case "max-age":
					cookie.maxAge = Number.parseInt(value, 10);
					break;
				case "secure":
					cookie.secure = true;
					break;
				case "httponly":
					cookie.httpOnly = true;
					break;
				case "samesite":
					cookie.sameSite = value.toLowerCase() as CookieOptions["sameSite"];
					break;
				case "partitioned":
					cookie.partitioned = true;
					break;
			}
		}
		return cookie;
	}

	isExpired(): boolean {
		if (this.maxAge !== undefined && this.maxAge <= 0) return true;
		return this.expires !== undefined && this.expires.getTime() <= Date.now();
	}

	/** `name=value`, as sent in a request `Cookie` header. */
	toString(): string {
		return `${this.name}=${this.value}`;
	}

	/** Full `Set-Cookie` header value, attributes included. */
	serialize(): string {
		const parts = [this.toString()];
		if (this.domain) parts.push(`Domain=${this.domain}`);
		if (this.path) parts.push(`Path=${this.path}`);
		if (this.expires) parts.push(`Expires=${this.expires.toUTCString()}`);
		if (this.maxAge !== undefined) parts.push(`Max-Age=${this.maxAge}`);
		if (this.secure) parts.push("Secure");
		if (this.httpOnly) parts.push("HttpOnly");
		if (this.sameSite) parts.push(`SameSite=${this.sameSite}`);
		if (this.partitioned) parts.push("Partitioned");
		return parts.join("; ");
	}
}

/** Map of cookie name → value, matching Bun's `CookieMap`. */
export class CookieMap extends Map<string, string> {
	constructor(init?: HeadersInit | string | (string | [string, string])[]) {
		super();
		if (init === undefined) return;
		if (typeof init === "string") {
			for (const pair of init.split(";")) {
				const equals = pair.indexOf("=");
				if (equals === -1) continue;
				this.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
			}
			return;
		}
		if (Array.isArray(init)) {
			for (const entry of init) {
				if (Array.isArray(entry)) this.set(entry[0], entry[1]);
				else {
					const parsed = Cookie.parse(entry);
					this.set(parsed.name, parsed.value);
				}
			}
			return;
		}
		const headers = new Headers(init);
		for (const header of headers.getSetCookie()) {
			const parsed = Cookie.parse(header);
			this.set(parsed.name, parsed.value);
		}
		const cookieHeader = headers.get("cookie");
		if (cookieHeader) {
			for (const [name, value] of new CookieMap(cookieHeader)) this.set(name, value);
		}
	}

	/** `Set-Cookie` header values for every entry. */
	toSetCookieHeaders(): string[] {
		return [...this.entries()].map(([name, value]) => new Cookie(name, value).serialize());
	}
}
