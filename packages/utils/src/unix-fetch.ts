/**
 * `fetch()` over a unix-domain socket or Windows named pipe.
 *
 * Bun's fetch accepted a `unix` init field that redirected the connection to a
 * local socket. Node's fetch has no such option, so this helper issues the same
 * request through `node:http` with `socketPath` and returns a real `Response`.
 */
import * as http from "node:http";
import { resolveLocalSocketPath } from "./ipc-path";

export interface UnixFetchInit extends Omit<RequestInit, "body"> {
	/** Request body; strings, byte buffers, and URLSearchParams are supported. */
	body?: RequestInit["body"];
}

function toRequestBody(body: RequestInit["body"]): Buffer | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return Buffer.from(body);
	if (body instanceof URLSearchParams) return Buffer.from(body.toString());
	if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	throw new TypeError("unixFetch: unsupported body type");
}

/** Perform an HTTP request against `socketPath` (unix socket or named pipe). */
export function unixFetch(socketPath: string, url: string, init: UnixFetchInit = {}): Promise<Response> {
	const target = new URL(url);
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const headers = new Headers(init.headers);
	const body = toRequestBody(init.body);
	if (body && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));
	const request = http.request(
		{
			socketPath: resolveLocalSocketPath(socketPath),
			path: `${target.pathname}${target.search}`,
			method: init.method ?? "GET",
			headers: Object.fromEntries(headers.entries()),
		},
		response => {
			const chunks: Buffer[] = [];
			response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
			response.on("end", () => {
				const responseHeaders = new Headers();
				for (const [key, value] of Object.entries(response.headers)) {
					if (value === undefined) continue;
					if (Array.isArray(value)) for (const entry of value) responseHeaders.append(key, entry);
					else responseHeaders.set(key, value);
				}
				resolve(
					new Response(Buffer.concat(chunks), {
						status: response.statusCode ?? 500,
						statusText: response.statusMessage,
						headers: responseHeaders,
					}),
				);
			});
			response.on("error", reject);
		},
	);
	request.on("error", reject);
	init.signal?.addEventListener("abort", () => request.destroy(new Error("unixFetch: aborted")), { once: true });
	request.end(body);
	return promise;
}
