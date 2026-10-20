import { createRequire } from "node:module";
import * as os from "node:os";
import {
	ensureChromiumExecutable,
	ensureSignInChromiumExecutable,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

// Launch policy reads `process.platform`; Chrome-for-Testing platform detection reads `os.platform()`.
// Pin both so the child resolves the emulated host's paths. Node's builtin `os` module shares its
// exports with the ESM namespace, so assigning here reaches production imports too.
const platform = process.env.OMP_BROWSER_PROBE_PLATFORM;
if (platform === "darwin" || platform === "win32") {
	Object.defineProperty(process, "platform", { value: platform });
	// The ESM namespace is frozen; mutate the CommonJS exports Node shares with it.
	const mutableOs = createRequire(import.meta.url)("node:os") as typeof os;
	Object.assign(mutableOs, { platform: () => platform });
} else if (platform) {
	throw new Error(`Unsupported OMP_BROWSER_PROBE_PLATFORM: ${platform}`);
}

const executable =
	process.env.OMP_BROWSER_PROBE_PURPOSE === "sign-in"
		? await ensureSignInChromiumExecutable()
		: await ensureChromiumExecutable();
process.stdout.write(executable ?? "");
