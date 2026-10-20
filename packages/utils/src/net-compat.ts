/**
 * `Bun.connect` / `Bun.listen` / `Bun.Socket` replacements over `node:net`.
 *
 * Bun exposed callback-driven sockets (`{ open, data, close, error, drain }`) and
 * bound listeners synchronously. Node binds asynchronously, so {@link listen}
 * resolves once the port is known; {@link connect} keeps Bun's promise contract.
 */
import * as net from "node:net";
import * as tls from "node:tls";
import { resolveLocalSocketPath } from "./ipc-path";

export interface SocketHandlers {
	open?(socket: NodeSocket): void;
	data?(socket: NodeSocket, data: Buffer): void;
	close?(socket: NodeSocket, error?: Error): void;
	error?(socket: NodeSocket, error: Error): void;
	drain?(socket: NodeSocket): void;
	end?(socket: NodeSocket): void;
	timeout?(socket: NodeSocket): void;
	connectError?(socket: NodeSocket, error: Error): void;
}

export interface ConnectOptions {
	hostname?: string;
	port?: number;
	unix?: string;
	tls?: boolean | tls.ConnectionOptions;
	socket: SocketHandlers;
}

export interface ListenOptions {
	hostname?: string;
	port?: number;
	unix?: string;
	reusePort?: boolean;
	socket: SocketHandlers;
}

/** One connected socket, shaped like `Bun.Socket`. */
export class NodeSocket {
	readonly #socket: net.Socket;
	#handlers: SocketHandlers;
	readonly #closed: Promise<void>;
	readonly #resolveClosed: () => void;

	constructor(socket: net.Socket, handlers: SocketHandlers) {
		this.#socket = socket;
		this.#handlers = handlers;
		const deferred = Promise.withResolvers<void>();
		this.#closed = deferred.promise;
		this.#resolveClosed = deferred.resolve;
		socket.on("data", (chunk: Buffer) => this.#handlers.data?.(this, chunk));
		socket.on("drain", () => this.#handlers.drain?.(this));
		socket.on("end", () => this.#handlers.end?.(this));
		socket.on("timeout", () => this.#handlers.timeout?.(this));
		socket.on("error", (error: Error) => this.#handlers.error?.(this, error));
		socket.on("close", (hadError: boolean) => {
			this.#handlers.close?.(this, hadError ? new Error("socket closed with error") : undefined);
			this.#resolveClosed();
		});
	}

	get readyState(): "open" | "closed" {
		return this.#socket.destroyed ? "closed" : "open";
	}

	get remoteAddress(): string | null {
		return this.#socket.remoteAddress ?? null;
	}

	get localAddress(): string | null {
		return this.#socket.localAddress ?? null;
	}

	get bytesWritten(): number {
		return this.#socket.bytesWritten;
	}

	get closed(): Promise<void> {
		return this.#closed;
	}

	write(data: string | Uint8Array): number {
		const buffer = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
		this.#socket.write(buffer);
		return buffer.byteLength;
	}

	flush(): void {
		// Node flushes on its own write queue; nothing to force here.
	}

	end(data?: string | Uint8Array): void {
		if (data === undefined) this.#socket.end();
		else this.#socket.end(typeof data === "string" ? data : Buffer.from(data));
	}

	destroy(): void {
		this.#socket.destroy();
	}

	timeout(milliseconds: number): void {
		this.#socket.setTimeout(milliseconds);
	}

	ref(): void {
		this.#socket.ref();
	}

	unref(): void {
		this.#socket.unref();
	}

	/** Swap the handlers attached to an existing socket. */
	reload(options: { socket: SocketHandlers }): void {
		this.#handlers = options.socket;
	}
}

/** Connect to a TCP or unix socket; mirrors `Bun.connect`. */
export function connect(options: ConnectOptions): Promise<NodeSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<NodeSocket>();
	const target = options.unix
		? { path: resolveLocalSocketPath(options.unix) }
		: { host: options.hostname ?? "127.0.0.1", port: options.port ?? 0 };
	const raw =
		options.tls && options.tls !== true
			? tls.connect({ ...(options.tls as tls.ConnectionOptions), ...target })
			: options.tls
				? tls.connect(target)
				: net.connect(target);
	const socket = new NodeSocket(raw, options.socket);
	let opened = false;
	raw.once("connect", () => {
		opened = true;
		options.socket.open?.(socket);
		resolve(socket);
	});
	raw.once("error", (error: Error) => {
		options.socket.connectError?.(socket, error);
		if (!opened) reject(error);
	});
	return promise;
}

/** Bound listener, shaped like `Bun.listen`'s return value. */
export interface Listener {
	readonly port: number;
	readonly hostname: string;
	stop(closeActiveConnections?: boolean): Promise<void>;
	reload(options: ListenOptions): void;
	ref(): void;
	unref(): void;
}

/** Bind a TCP or unix listener; resolves once the port is assigned. */
export async function listen(options: ListenOptions): Promise<Listener> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer(raw => {
		sockets.add(raw);
		raw.on("close", () => sockets.delete(raw));
		const socket = new NodeSocket(raw, options.socket);
		options.socket.open?.(socket);
	});
	const deferred = Promise.withResolvers<void>();
	server.once("error", deferred.reject);
	server.listen(
		options.unix
			? { path: resolveLocalSocketPath(options.unix), exclusive: !options.reusePort }
			: { host: options.hostname ?? "0.0.0.0", port: options.port ?? 0, reusePort: options.reusePort },
		() => {
			server.off("error", deferred.reject);
			deferred.resolve();
		},
	);
	await deferred.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		port,
		hostname: options.hostname ?? "0.0.0.0",
		async stop(closeActiveConnections?: boolean) {
			if (closeActiveConnections) for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
		reload(next: ListenOptions) {
			options.socket = next.socket;
		},
		ref: () => server.ref(),
		unref: () => server.unref(),
	};
}

/** Bun's type name for {@link NodeSocket}. */
export type Socket = NodeSocket;
