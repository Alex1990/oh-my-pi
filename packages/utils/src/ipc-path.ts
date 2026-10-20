/**
 * Map a unix-domain socket path onto the platform's local IPC namespace.
 *
 * POSIX uses the path as-is. Windows has no AF_UNIX file sockets in Node, so a
 * caller-supplied path becomes a deterministic named pipe — both ends derive the
 * same name, which is what Bun did internally.
 */
import { createHash } from "node:crypto";

const PIPE_PREFIX = "\\\\.\\pipe\\";

export function resolveLocalSocketPath(socketPath: string): string {
	if (process.platform !== "win32") return socketPath;
	if (socketPath.startsWith(PIPE_PREFIX)) return socketPath;
	const digest = createHash("sha256").update(socketPath).digest("hex").slice(0, 32);
	return `${PIPE_PREFIX}oyp-${digest}`;
}
