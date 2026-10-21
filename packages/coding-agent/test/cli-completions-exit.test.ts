import { afterEach, describe, expect, it, spyOn } from "@oh-my-pi/pi-utils/test-runtime";
import { postmortem } from "@oh-my-pi/pi-utils";
import Completions from "../src/commands/completions";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

describe("Completions command exit contract", () => {
	afterEach(() => {
		spyOn(postmortem, "quit").mockRestore();
		spyOn(bun, "write").mockRestore();
	});

	it("calls postmortem.quit(0) after writing completion script", async () => {
		const quitSpy = spyOn(postmortem, "quit").mockResolvedValue(undefined);
		const writeSpy = spyOn(bun, "write").mockResolvedValue(0);
		const config = { bin: "oyp", version: "0.0.0", commands: new Map() };
		const cmd = new Completions(["zsh"], config);
		await cmd.run();

		expect(writeSpy).toHaveBeenCalled();
		expect(quitSpy).toHaveBeenCalledWith(0);
	});
});
