/**
 * `fetch.preconnect` is a Bun runtime extension to `fetch`; Node's fetch has no
 * such method. Callers keep the optional chaining they had, but read it through
 * this accessor so the Node typings stay honest.
 */
export interface FetchPreconnect {
	(url: string | URL, options?: { dns?: boolean; http?: boolean; tcp?: boolean; tls?: boolean }): void;
}

/** Optional `preconnect` hook exposed by the runtime's fetch implementation. */
export function preconnectOf(implementation: typeof fetch): FetchPreconnect | undefined {
	const candidate = (implementation as typeof fetch & { preconnect?: FetchPreconnect }).preconnect;
	return typeof candidate === "function" ? candidate : undefined;
}
