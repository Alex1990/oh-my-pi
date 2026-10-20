import * as path from "node:path";

let pipeCounter = 0;

/**
 * A local socket address that both Node and Bun can listen on.
 *
 * Bun accepts AF_UNIX paths on every platform; Node only accepts named pipes on
 * Windows (`\\.\pipe\<name>`) and rejects AF_UNIX file paths with `EACCES`.
 * Tests that need a real local socket therefore ask for a pipe on Windows.
 */
export function testSocketPath(directory: string, name = "daemon"): string {
	if (process.platform === "win32") {
		pipeCounter++;
		const unique = Math.random().toString(36).slice(2);
		return `\\\\.\\pipe\\omp-${name}-${process.pid}-${pipeCounter}-${unique}`;
	}
	return path.join(directory, `${name}.sock`);
}
