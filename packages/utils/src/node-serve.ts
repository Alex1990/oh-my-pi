/**
 * `serve` / `WebSocket` replacements over Node's `node:http` and the
 * `ws` package.
 *
 * The one intentional divergence: Node binds ports asynchronously, so
 * {@link serve} is `await`-able and resolves only after `listen` succeeded.
 * Everything else — `fetch`, `websocket`, `server.upgrade`, `server.publish`,
 * `server.requestIP`, `server.stop` — keeps Bun's shape.
 */
import * as http from "node:http";
import * as https from "node:https";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import WebSocketImpl, { WebSocketServer } from "ws";
import { resolveLocalSocketPath } from "./ipc-path";

type HeadersInit = Headers | Record<string, string> | [string, string][];

export interface ServerWebSocket<T = unknown> {
	readonly data: T;
	readonly readyState: number;
	readonly remoteAddress: string | null;
	send(data: string | Uint8Array): void;
	ping(data?: Uint8Array): void;
	close(code?: number, reason?: string): void;
	subscribe(topic: string): void;
	unsubscribe(topic: string): void;
	publish(topic: string, data: string | Uint8Array): void;
	cork(callback: () => void): void;
	binaryType: "arraybuffer" | "uint8array" | "nodebuffer";
}

export interface WebSocketHandler<T = unknown> {
	open?(ws: ServerWebSocket<T>): void;
	message?(ws: ServerWebSocket<T>, message: string | Uint8Array): void;
	close?(ws: ServerWebSocket<T>, code: number, reason: string): void;
	drain?(ws: ServerWebSocket<T>): void;
	ping?(ws: ServerWebSocket<T>, data: Uint8Array): void;
	pong?(ws: ServerWebSocket<T>, data: Uint8Array): void;
	maxPayloadLength?: number;
	idleTimeout?: number;
	perMessageDeflate?: boolean;
	backpressureLimit?: number;
	closeOnBackpressureLimit?: boolean;
	sendPings?: boolean;
	publishToSelf?: boolean;
	headers?: HeadersInit;
}

export interface ServeOptions<T = unknown> {
	port?: number;
	hostname?: string;
	unix?: string;
	reusePort?: boolean;
	fetch(request: Request, server: Server<T>): Response | undefined | Promise<Response | undefined>;
	websocket?: WebSocketHandler<T>;
	error?(error: Error): Response | Promise<Response>;
	tls?: { key?: string | Buffer; cert?: string | Buffer } | null;
	maxRequestBodySize?: number;
	idleTimeout?: number;
	development?: boolean;
}

export interface Server<T = unknown> {
	readonly port: number;
	readonly hostname: string;
	readonly url: URL;
	readonly pendingRequests: number;
	readonly development: boolean;
	stop(closeActiveConnections?: boolean): Promise<void>;
	reload(options: ServeOptions<T>): Promise<void>;
	upgrade(request: Request, options?: { data?: T; headers?: HeadersInit }): boolean;
	publish(topic: string, data: string | Uint8Array): number;
	subscriberCount(topic: string): number;
	requestIP(request: Request): { address: string; family: string; port: number } | null;
	fetch(request: Request): Promise<Response | undefined>;
	ref(): void;
	unref(): void;
}

interface UpgradeHandshake {
	request: http.IncomingMessage;
	socket: Duplex;
	head: Buffer;
	upgraded: boolean;
}

const requestSources = new WeakMap<Request, http.IncomingMessage>();
const pendingUpgrades = new WeakMap<Request, UpgradeHandshake>();

function toWebRequest(raw: http.IncomingMessage, scheme: string): Request {
	const host = raw.headers.host ?? "localhost";
	const url = `${scheme}://${host}${raw.url ?? "/"}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(raw.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const entry of value) headers.append(key, entry);
		else headers.set(key, value);
	}
	const method = raw.method ?? "GET";
	const hasBody = method !== "GET" && method !== "HEAD";
	// `duplex` is required for streaming request bodies but is absent from the
	// DOM `RequestInit` typings Node ships.
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers,
		body: hasBody ? (Readable.toWeb(raw) as ReadableStream<Uint8Array>) : undefined,
		duplex: hasBody ? "half" : undefined,
	};
	const request = new Request(url, init);
	requestSources.set(request, raw);
	return request;
}

async function writeResponse(task: { response: Response; target: http.ServerResponse | Duplex }): Promise<void> {
	const { response, target } = task;
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	if ("writeHead" in target) {
		const res = target as http.ServerResponse;
		res.writeHead(response.status, response.statusText || undefined, headers);
		if (!response.body) {
			res.end();
			return;
		}
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!res.write(value)) await new Promise<void>(resolve => res.once("drain", () => resolve()));
		}
		res.end();
		return;
	}
	// Raw socket (failed upgrade): emit a minimal HTTP/1.1 response.
	const socket = target as Duplex;
	const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
	const headerLines = Object.entries(headers).map(([key, value]) =>
		Array.isArray(value) ? value.map(entry => `${key}: ${entry}`).join("\r\n") : `${key}: ${value}`,
	);
	socket.write(
		`HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\n${headerLines.join("\r\n")}\r\ncontent-length: ${body.byteLength}\r\n\r\n`,
	);
	socket.write(body);
	socket.end();
}

class BunServer<T> implements Server<T> {
	readonly #handler: ServeOptions<T>;
	readonly #http: http.Server | https.Server;
	readonly #wss: WebSocketServer | null;
	readonly #topics = new Map<string, Set<ServerWebSocket<T>>>();
	readonly #development: boolean;
	#pending = 0;
	#listening = false;
	#address: { port: number; hostname: string } = { port: 0, hostname: "localhost" };

	constructor(handler: ServeOptions<T>) {
		this.#handler = handler;
		this.#development = handler.development ?? false;
		const listener = (raw: http.IncomingMessage, res: http.ServerResponse) => {
			void this.#handle(raw, res);
		};
		this.#http = handler.tls
			? https.createServer({ key: handler.tls.key, cert: handler.tls.cert }, listener as never)
			: http.createServer(listener);
		if (handler.idleTimeout !== undefined) {
			this.#http.keepAliveTimeout = handler.idleTimeout * 1000;
			this.#http.headersTimeout = Math.max(this.#http.keepAliveTimeout + 1000, this.#http.headersTimeout);
		}
		this.#wss = handler.websocket
			? new WebSocketServer({
					noServer: true,
					maxPayload: handler.websocket.maxPayloadLength,
					perMessageDeflate: handler.websocket.perMessageDeflate,
				})
			: null;
		this.#http.on("upgrade", (raw, socket, head) => {
			if (!this.#wss) {
				socket.destroy();
				return;
			}
			const request = toWebRequest(raw, handler.tls ? "https" : "http");
			pendingUpgrades.set(request, { request: raw, socket, head, upgraded: false });
			void this.#handleUpgradeRequest(request);
		});
	}

	async listen(): Promise<void> {
		const deferred = Promise.withResolvers<void>();
		this.#http.once("error", deferred.reject);
		this.#http.once("listening", () => {
			const address = this.#http.address();
			if (typeof address === "object" && address) {
				this.#address = {
					port: address.port,
					hostname: this.#handler.hostname ?? (address.family === "IPv6" ? "::" : "0.0.0.0"),
				};
			}
			this.#listening = true;
			this.#http.off("error", deferred.reject);
			deferred.resolve();
		});
		if (this.#handler.unix) this.#http.listen(resolveLocalSocketPath(this.#handler.unix));
		else this.#http.listen(this.#handler.port ?? 0, this.#handler.hostname ?? "0.0.0.0");
		await deferred.promise;
	}

	get port(): number {
		return this.#address.port;
	}

	get hostname(): string {
		return this.#address.hostname;
	}

	get url(): URL {
		const host = this.#address.hostname.includes(":") ? `[${this.#address.hostname}]` : this.#address.hostname;
		return new URL(`${this.#handler.tls ? "https" : "http"}://${host}:${this.#address.port}`);
	}

	get pendingRequests(): number {
		return this.#pending;
	}

	get development(): boolean {
		return this.#development;
	}

	async stop(_closeActiveConnections?: boolean): Promise<void> {
		for (const clients of this.#topics.values()) {
			for (const ws of clients) ws.close(1001, "server stopping");
		}
		this.#topics.clear();
		this.#wss?.close();
		if (!this.#listening) return;
		const deferred = Promise.withResolvers<void>();
		this.#http.close(() => deferred.resolve());
		this.#http.closeAllConnections?.();
		await deferred.promise;
		this.#listening = false;
	}

	async reload(options: ServeOptions<T>): Promise<void> {
		void options;
		throw new Error("Server.reload() is not supported by the Node runtime");
	}

	upgrade(request: Request, options?: { data?: T; headers?: HeadersInit }): boolean {
		const handshake = pendingUpgrades.get(request);
		if (!handshake || !this.#wss || handshake.upgraded) return false;
		handshake.upgraded = true;
		const remoteAddress = handshake.request.socket.remoteAddress ?? null;
		this.#wss.handleUpgrade(handshake.request, handshake.socket, handshake.head, socket => {
			const wrapped = this.#wrapSocket(socket, options?.data as T, remoteAddress);
			const handler = this.#handler.websocket;
			handler?.open?.(wrapped);
			socket.on("message", (data, isBinary) => {
				handler?.message?.(wrapped, isBinary ? new Uint8Array(data as Buffer) : data.toString());
			});
			socket.on("close", (code, reason) => handler?.close?.(wrapped, code, reason.toString()));
			socket.on("ping", data => handler?.ping?.(wrapped, new Uint8Array(data)));
			socket.on("pong", data => handler?.pong?.(wrapped, new Uint8Array(data)));
		});
		return true;
	}

	publish(topic: string, data: string | Uint8Array): number {
		const clients = this.#topics.get(topic);
		if (!clients) return 0;
		let delivered = 0;
		for (const client of clients) {
			client.send(data);
			delivered++;
		}
		return delivered;
	}

	subscriberCount(topic: string): number {
		return this.#topics.get(topic)?.size ?? 0;
	}

	requestIP(request: Request): { address: string; family: string; port: number } | null {
		const raw = requestSources.get(request);
		const remote = raw?.socket.remoteAddress;
		if (!remote) return null;
		const family = remote.includes(":") ? "IPv6" : "IPv4";
		return { address: remote, family, port: raw?.socket.remotePort ?? 0 };
	}

	async fetch(request: Request): Promise<Response | undefined> {
		return await this.#dispatch(request);
	}

	ref(): void {
		this.#http.ref();
	}

	unref(): void {
		this.#http.unref();
	}

	async #handle(raw: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const request = toWebRequest(raw, this.#handler.tls ? "https" : "http");
		this.#pending++;
		try {
			const response = await this.#dispatch(request);
			if (!response) {
				res.statusCode = 204;
				res.end();
				return;
			}
			await writeResponse({ response, target: res });
		} catch (error) {
			await this.#writeError(error, res);
		} finally {
			this.#pending--;
		}
	}

	async #handleUpgradeRequest(request: Request): Promise<void> {
		const handshake = pendingUpgrades.get(request);
		try {
			const response = await this.#dispatch(request);
			if (!handshake || handshake.upgraded) return;
			if (response) await writeResponse({ response, target: handshake.socket });
			else handshake.socket.destroy();
		} catch (error) {
			if (handshake && !handshake.upgraded) {
				const response = await this.#errorResponse(error);
				await writeResponse({ response, target: handshake.socket });
			}
		} finally {
			if (handshake) pendingUpgrades.delete(request);
		}
	}

	async #dispatch(request: Request): Promise<Response | undefined> {
		try {
			return await this.#handler.fetch(request, this);
		} catch (error) {
			return await this.#errorResponse(error);
		}
	}

	async #errorResponse(error: unknown): Promise<Response> {
		if (this.#handler.error && error instanceof Error) return await this.#handler.error(error);
		return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
	}

	async #writeError(error: unknown, res: http.ServerResponse): Promise<void> {
		await writeResponse({ response: await this.#errorResponse(error), target: res });
	}

	#wrapSocket(socket: WebSocketImpl, data: T, remoteAddress: string | null): ServerWebSocket<T> {
		const server = this;
		const topics = new Set<string>();
		const wrapped: ServerWebSocket<T> = {
			data,
			get readyState() {
				return socket.readyState;
			},
			remoteAddress,
			binaryType: "nodebuffer",
			send: payload => socket.send(payload),
			ping: data => socket.ping(data === undefined ? undefined : Buffer.from(data)),
			close: (code, reason) => socket.close(code, reason),
			subscribe(topic) {
				topics.add(topic);
				let clients = server.#topics.get(topic);
				if (!clients) {
					clients = new Set();
					server.#topics.set(topic, clients);
				}
				clients.add(wrapped);
			},
			unsubscribe(topic) {
				topics.delete(topic);
				server.#topics.get(topic)?.delete(wrapped);
			},
			publish(topic, payload) {
				server.publish(topic, payload);
			},
			cork(callback) {
				callback();
			},
		};
		socket.on("close", () => {
			for (const topic of topics) server.#topics.get(topic)?.delete(wrapped);
		});
		return wrapped;
	}
}

/** Start an HTTP(S) server. Resolves once the socket is listening. */
export async function serve<T = unknown>(options: ServeOptions<T>): Promise<Server<T>> {
	const server = new BunServer<T>(options);
	await server.listen();
	return server;
}

// ---------------------------------------------------------------------------
// Client WebSocket
// ---------------------------------------------------------------------------

export interface WebSocketOptions {
	headers?: HeadersInit;
	protocols?: string | string[];
	perMessageDeflate?: boolean;
	tls?: { rejectUnauthorized?: boolean };
	proxy?: string;
}

/** Close event with the fields the call sites read. */
export class WebSocketCloseEvent extends Event {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;

	constructor(code: number, reason: string, wasClean: boolean) {
		super("close");
		this.code = code;
		this.reason = reason;
		this.wasClean = wasClean;
	}
}

type EventHandler<E extends Event> = ((event: E) => void) | null;

/**
 * Browser-shaped `WebSocket` the way Bun exposes it globally.
 *
 * The `ws` implementation is composed rather than subclassed: its event objects
 * are not DOM `Event`s, and call sites written against Bun's WebSocket use
 * `onopen`/`onmessage`/`onclose`/`onerror` plus `addEventListener`. This adapter
 * re-emits `ws` events as DOM events and keeps the constructor shape where the
 * second argument may be a protocols list or an options object with `headers`.
 */
export class WebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly #socket: WebSocketImpl;
	#onopen: EventHandler<Event> = null;
	#onmessage: EventHandler<MessageEvent> = null;
	#onclose: EventHandler<WebSocketCloseEvent> = null;
	#onerror: EventHandler<Event> = null;

	constructor(
		url: string | URL,
		protocolsOrOptions?: string | string[] | WebSocketOptions,
		options?: WebSocketOptions,
	) {
		super();
		const target = url.toString();
		const resolved =
			protocolsOrOptions !== undefined &&
			typeof protocolsOrOptions === "object" &&
			!Array.isArray(protocolsOrOptions)
				? protocolsOrOptions
				: (options ?? {});
		const protocols =
			typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions)
				? protocolsOrOptions
				: resolved.protocols;
		this.#socket = new WebSocketImpl(target, protocols ?? [], {
			headers: resolved.headers as Record<string, string> | undefined,
			perMessageDeflate: resolved.perMessageDeflate,
			rejectUnauthorized: resolved.tls?.rejectUnauthorized,
		});
		this.#socket.on("open", () => this.#emit(new Event("open"), "open"));
		this.#socket.on("message", (data, isBinary) => {
			const payload = isBinary ? new Uint8Array(data as Buffer) : data.toString();
			this.#emit(new MessageEvent("message", { data: payload }), "message");
		});
		this.#socket.on("close", (code, reason) => {
			this.#emit(new WebSocketCloseEvent(code, reason.toString(), code === 1000), "close");
		});
		this.#socket.on("error", error => {
			this.#emit(new WorkerErrorEventLike(error.message, error), "error");
		});
	}

	get readyState(): number {
		return this.#socket.readyState;
	}

	get bufferedAmount(): number {
		return this.#socket.bufferedAmount;
	}

	get protocol(): string {
		return this.#socket.protocol;
	}

	get extensions(): string {
		return this.#socket.extensions;
	}

	get url(): string {
		return this.#socket.url;
	}

	get binaryType(): string {
		return this.#socket.binaryType;
	}

	set binaryType(value: string) {
		this.#socket.binaryType = value as "nodebuffer" | "arraybuffer" | "fragments";
	}

	get onopen(): EventHandler<Event> {
		return this.#onopen;
	}

	set onopen(handler: EventHandler<Event>) {
		this.#onopen = handler;
	}

	get onmessage(): EventHandler<MessageEvent> {
		return this.#onmessage;
	}

	set onmessage(handler: EventHandler<MessageEvent>) {
		this.#onmessage = handler;
	}

	get onclose(): EventHandler<WebSocketCloseEvent> {
		return this.#onclose;
	}

	set onclose(handler: EventHandler<WebSocketCloseEvent>) {
		this.#onclose = handler;
	}

	get onerror(): EventHandler<Event> {
		return this.#onerror;
	}

	set onerror(handler: EventHandler<Event>) {
		this.#onerror = handler;
	}

	send(data: string | ArrayBuffer | ArrayBufferView): void {
		this.#socket.send(data as string | Buffer);
	}

	close(code?: number, reason?: string): void {
		this.#socket.close(code, reason);
	}

	terminate(): void {
		this.#socket.terminate();
	}

	/** Send a WebSocket ping frame (Bun exposed this on its socket). */
	ping(data?: string | Uint8Array): void {
		this.#socket.ping(data);
	}

	#emit<E extends Event>(event: E, kind: "open" | "message" | "close" | "error"): void {
		this.dispatchEvent(event);
		const handler =
			kind === "open"
				? this.#onopen
				: kind === "message"
					? (this.#onmessage as EventHandler<E> | null)
					: kind === "close"
						? (this.#onclose as EventHandler<E> | null)
						: this.#onerror;
		handler?.(event);
	}
}

/** Error event carrying the underlying failure, mirroring `Bun.WebSocket` errors. */
class WorkerErrorEventLike extends Event {
	readonly message: string;
	readonly error: unknown;

	constructor(message: string, error: unknown) {
		super("error");
		this.message = message;
		this.error = error;
	}
}
