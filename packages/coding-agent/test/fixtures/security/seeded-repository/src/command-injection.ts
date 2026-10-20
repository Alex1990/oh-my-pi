import { $ } from "@oh-my-pi/pi-utils/shell";

export async function lookupUserControlledHost(host: string): Promise<string> {
	// Deliberately vulnerable fixture: the shell receives untrusted text as syntax.
	return $`sh -c ${`nslookup ${host}`}`.text();
}
