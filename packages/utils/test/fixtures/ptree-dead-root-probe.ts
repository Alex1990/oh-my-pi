import { bun } from "@oh-my-pi/pi-utils/node-runtime";
const child = bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30_000)"], {
	stdin: "ignore",
	stdout: "inherit",
	stderr: "inherit",
	windowsHide: true,
	// Bun places Windows children in the parent job, which dies with the root;
	// detached lets this descendant outlive the probe and hold the pipe.
	detached: true,
});

await bun.write(bun.stdout, `${child.pid}\n`);
process.exit(0);
