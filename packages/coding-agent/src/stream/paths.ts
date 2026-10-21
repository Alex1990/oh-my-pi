import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getDaemonRuntimeDir } from "@oh-my-pi/pi-utils";
import { canonicalProjectDir } from "../launch/paths";

/**
 * Resolve the local IPC endpoint `oyp stream` listens on for one project
 * directory. Shares the daemon broker's canonical-cwd hashing so every oyp
 * process in the same directory agrees on the endpoint.
 */
export async function streamSocketEndpoint(projectDir: string): Promise<string> {
	return ipcEndpoint(getDaemonRuntimeDir(await canonicalProjectDir(projectDir)), "stream");
}
