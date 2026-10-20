/**
 * Minimal Redis client on `node:net`.
 *
 * Stands in for Bun's `bun:redis` `RedisClient` for the surfaces this repository
 * uses (`send`, string, hash, key, and scan commands). One connection, requests
 * pipelined in order, RESP2 replies decoded incrementally.
 */
import * as net from "node:net";

type RespValue = string | number | null | RespValue[] | RedisReplyError;

/** One decoded error reply. */
class RedisReplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RedisReplyError";
	}
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

export interface RedisClientOptions {
	url?: string;
	host?: string;
	port?: number;
	database?: number;
	password?: string;
}

/** `bun:redis`-compatible client backed by a single TCP connection. */
export class RedisClient {
	readonly #host: string;
	readonly #port: number;
	readonly #database: number;
	readonly #password: string | undefined;
	#socket: net.Socket | null = null;
	#buffer = Buffer.alloc(0);
	#pending: PendingRequest[] = [];
	#connecting: Promise<void> | null = null;

	constructor(options: string | RedisClientOptions = {}) {
		const resolved =
			typeof options === "string"
				? { url: options }
				: options.url
					? options
					: { ...options, url: process.env.REDIS_URL ?? process.env.VALKEY_URL };
		const url = resolved.url ? new URL(resolved.url) : null;
		this.#host = url?.hostname ?? resolved.host ?? "127.0.0.1";
		this.#port = url?.port ? Number(url.port) : (resolved.port ?? 6379);
		this.#database =
			url?.pathname && url.pathname.length > 1 ? Number(url.pathname.slice(1)) : (resolved.database ?? 0);
		this.#password = url?.password
			? decodeURIComponent(url.password)
			: (resolved.password ?? process.env.REDIS_PASSWORD);
	}

	/** Connect (idempotent) and perform AUTH/SELECT. */
	async connect(): Promise<void> {
		if (this.#socket && !this.#socket.destroyed) return;
		this.#connecting ??= this.#open();
		await this.#connecting;
	}

	/** Send one command and resolve its decoded reply. */
	async send(command: string, args: string[] = []): Promise<unknown> {
		await this.connect();
		const socket = this.#socket;
		if (!socket) throw new Error("RedisClient: not connected");
		const parts = [command, ...args];
		let request = `*${parts.length}\r\n`;
		for (const part of parts) request += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.push({ resolve, reject });
		socket.write(request, "utf8");
		return await promise;
	}

	async ping(): Promise<string> {
		return String(await this.send("PING"));
	}

	async get(key: string): Promise<string | null> {
		return decodeString(await this.send("GET", [key]));
	}

	async getrange(key: string, start: number, end: number): Promise<string> {
		return decodeString(await this.send("GETRANGE", [key, String(start), String(end)])) ?? "";
	}

	async strlen(key: string): Promise<number> {
		return Number(await this.send("STRLEN", [key]));
	}

	async set(key: string, value: string): Promise<unknown> {
		return await this.send("SET", [key, value]);
	}

	async append(key: string, value: string): Promise<number> {
		return Number(await this.send("APPEND", [key, value]));
	}

	async del(...keys: string[]): Promise<number> {
		return Number(await this.send("DEL", keys));
	}

	async rename(source: string, destination: string): Promise<unknown> {
		return await this.send("RENAME", [source, destination]);
	}

	async scan(cursor: string, ...args: string[]): Promise<[string, string[]]> {
		const reply = await this.send("SCAN", [cursor, ...args]);
		if (!Array.isArray(reply) || reply.length !== 2) throw new Error("RedisClient: malformed SCAN reply");
		return [String(reply[0]), (reply[1] as RespValue[]).map(value => String(value))];
	}

	async hset(key: string, field: string, value: string): Promise<unknown> {
		return await this.send("HSET", [key, field, value]);
	}

	async hgetall(key: string): Promise<Record<string, string>> {
		const reply = await this.send("HGETALL", [key]);
		const out: Record<string, string> = {};
		if (Array.isArray(reply)) {
			for (let index = 0; index + 1 < reply.length; index += 2) {
				out[String(reply[index])] = String(reply[index + 1]);
			}
		}
		return out;
	}

	async hdel(key: string, ...fields: string[]): Promise<unknown> {
		return await this.send("HDEL", [key, ...fields]);
	}

	close(): void {
		this.#socket?.destroy();
		this.#socket = null;
		this.#failAll(new Error("RedisClient: closed"));
	}

	#open(): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const socket = net.connect({ host: this.#host, port: this.#port });
		socket.setNoDelay(true);
		this.#socket = socket;
		socket.on("data", chunk => this.#onData(chunk));
		socket.on("error", error => {
			this.#failAll(error);
			reject(error);
		});
		socket.on("close", () => {
			this.#failAll(new Error("RedisClient: connection closed"));
		});
		socket.once("connect", () => {
			void this.#handshake().then(resolve, reject);
		});
		return promise;
	}

	async #handshake(): Promise<void> {
		if (this.#password) await this.send("AUTH", [this.#password]);
		if (this.#database !== 0) await this.send("SELECT", [String(this.#database)]);
	}

	#failAll(error: Error): void {
		const pending = this.#pending;
		this.#pending = [];
		for (const request of pending) request.reject(error);
	}

	#onData(chunk: Buffer): void {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			const decoded = decodeReply(this.#buffer, 0);
			if (!decoded) return;
			this.#buffer = this.#buffer.subarray(decoded.next);
			const pending = this.#pending.shift();
			if (!pending) continue;
			if (decoded.value instanceof RedisReplyError) pending.reject(decoded.value as RedisReplyError);
			else pending.resolve(decoded.value);
		}
	}
}

function decodeString(value: unknown): string | null {
	if (value === null) return null;
	return String(value);
}

function decodeReply(buffer: Buffer, offset: number): { value: RespValue; next: number } | null {
	if (offset >= buffer.length) return null;
	const type = String.fromCharCode(buffer[offset]);
	const lineEnd = buffer.indexOf("\r\n", offset + 1);
	if (lineEnd === -1) return null;
	const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
	const next = lineEnd + 2;
	switch (type) {
		case "+":
			return { value: line, next };
		case "-":
			return { value: new RedisReplyError(line), next };
		case ":":
			return { value: Number(line), next };
		case "$": {
			const length = Number(line);
			if (length === -1) return { value: null, next };
			const end = next + length;
			if (buffer.length < end + 2) return null;
			return { value: buffer.subarray(next, end).toString("utf8"), next: end + 2 };
		}
		case "*": {
			const count = Number(line);
			if (count === -1) return { value: null, next };
			const items: RespValue[] = [];
			let cursor = next;
			for (let index = 0; index < count; index++) {
				const item = decodeReply(buffer, cursor);
				if (!item) return null;
				items.push(item.value);
				cursor = item.next;
			}
			return { value: items, next: cursor };
		}
		default:
			throw new Error(`RedisClient: unknown reply type '${type}'`);
	}
}
