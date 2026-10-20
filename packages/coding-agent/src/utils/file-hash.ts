import { bun } from "@oh-my-pi/pi-utils/node-runtime";
/** Lowercase hex SHA-256 of a file's contents, streamed so large files are never buffered whole. */
export async function sha256File(filePath: string): Promise<string> {
	const hasher = new bun.CryptoHasher("sha256");
	for await (const chunk of bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}
