import * as ffi from "@oh-my-pi/pi-utils/ffi";
import { spyOn } from "@oh-my-pi/pi-utils/test-runtime";

/** Controls the fake `SetConsoleTitleW` implementation installed for a test. */
export interface WindowsConsoleTitleMock {
	readonly titles: string[];
	succeeds: boolean;
	restore(): void;
}

const originalPtr = ffi.ptr;

/** Installs a type-safe `kernel32.dll` FFI double until {@link WindowsConsoleTitleMock.restore} runs. */
export function mockWindowsConsoleTitle(): WindowsConsoleTitleMock {
	// `ptr()` receives the UTF-16LE bytes the title writer passes to native code;
	// the double keeps the latest view instead of dereferencing the opaque pointer.
	let pending: Buffer | undefined;
	const mock: WindowsConsoleTitleMock = {
		titles: [],
		succeeds: false,
		restore() {
			ptrSpy.mockRestore();
			dlopenSpy.mockRestore();
		},
	};
	const ptrSpy = spyOn(ffi, "ptr").mockImplementation((view: ArrayBufferView | null) => {
		if (view instanceof Uint8Array) pending = Buffer.from(view);
		return originalPtr(view);
	});
	const dlopenSpy = spyOn(ffi, "dlopen").mockImplementation(((_path: string, definition: Record<string, unknown>) => {
		if (!("SetConsoleTitleW" in definition)) throw new Error("SetConsoleTitleW binding missing");
		return {
			symbols: {
				SetConsoleTitleW: () => {
					if (!mock.succeeds) return false;
					const title = pending?.toString("utf16le").replace(/\0[\s\S]*$/, "") ?? "";
					mock.titles.push(title);
					return true;
				},
			},
			close() {},
		};
	}) as unknown as typeof ffi.dlopen);
	return mock;
}
