import { isTestRuntime } from "@oh-my-pi/pi-utils/env";

process.stdout.write(JSON.stringify(isTestRuntime()));
