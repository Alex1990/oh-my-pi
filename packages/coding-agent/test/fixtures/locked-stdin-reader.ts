import { bun } from "@oh-my-pi/pi-utils/node-runtime";
const lockedStdinReader = bun.stdin.stream().getReader();
void lockedStdinReader;

export default function lockedStdinReaderExtension(): void {}
