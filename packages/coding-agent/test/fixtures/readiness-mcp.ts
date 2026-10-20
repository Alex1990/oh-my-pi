#!/usr/bin/env bun
/** Minimal stdio MCP server with independently delayed startup and tools/call. */
import * as readline from "node:readline";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";
import { isMainModule } from "@oh-my-pi/pi-utils/node-runtime";

const name = bun.env.SRV_NAME ?? "srv";
const startupDelayMs = Number(bun.env.DELAY_STARTUP ?? 0);
const callDelayMs = Number(bun.env.DELAY_CALL ?? 0);

async function serve(): Promise<void> {
	if (startupDelayMs > 0) await bun.sleep(startupDelayMs);
	const lines = readline.createInterface({ input: process.stdin });
	for await (const line of lines) {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof request !== "object" || request === null || !("method" in request)) continue;
		const method = request.method;
		if (!("id" in request)) continue;
		let result: object;
		switch (method) {
			case "initialize":
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name, version: "1.0.0" },
				};
				break;
			case "tools/list":
				result = {
					tools: [
						{
							name: `${name}_marker`,
							description: `Return the ${name} marker.`,
							inputSchema: { type: "object", properties: {} },
						},
					],
				};
				break;
			case "tools/call":
				if (callDelayMs > 0) await bun.sleep(callDelayMs);
				result = { content: [{ type: "text", text: `MARKER_OK::${name}` }] };
				break;
			default:
				result = {};
		}
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
	}
}

if (isMainModule(import.meta.url)) void serve();
