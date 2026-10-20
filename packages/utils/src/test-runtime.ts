/**
 * Test-runner compatibility surface.
 *
 * The repository's suites were written against `bun:test`; Vitest implements the
 * same Jest-shaped API (`describe`/`it`/`expect`/hooks), so tests import this
 * module instead of the Bun runner. It re-exports Vitest and adds the handful of
 * `bun:test`-only helpers (`spyOn`, `mock`, `setSystemTime`, `setDefaultTimeout`,
 * `jest`) on top of Vitest's implementations.
 *
 * Test-only module: never import it from shipped code.
 */
export {
	afterAll,
	afterEach,
	assert,
	beforeAll,
	beforeEach,
	describe,
	expect,
	expectTypeOf,
	it,
	onTestFailed,
	onTestFinished,
	suite,
	test,
	vi,
} from "vitest";
import { expect, vi } from "vitest";

/** Bun exported `jest` as an alias for its mock controller. */
export const jest = vi;

/** `spyOn(object, "method")`, aliased onto `vi.spyOn`. */
export const spyOn: typeof vi.spyOn = vi.spyOn.bind(vi);

/**
 * `setSystemTime()` with no argument restores the real clock (Bun's behavior);
 * with a value it pins the fake clock.
 */
export function setSystemTime(date?: Date | number | string): void {
	if (date === undefined) vi.useRealTimers();
	else vi.setSystemTime(date);
}

/** Default timeout for every test in the file. */
export function setDefaultTimeout(milliseconds: number): void {
	vi.setConfig({ testTimeout: milliseconds });
}

/** Vitest's mock-instance type, re-exported under Bun's name. */
export type { MockInstance as Mock } from "vitest";

declare module "vitest" {
	interface Assertion<T = any> {
		toBeNumber(): void;
		toBeString(): void;
		toBeBoolean(): void;
		toBeFunction(): void;
		toBeArray(): void;
		toBeTrue(): void;
		toBeFalse(): void;
		toStartWith(prefix: string): void;
		toEndWith(suffix: string): void;
	}
	interface AsymmetricMatchersContaining {
		toBeNumber(): void;
		toBeString(): void;
		toBeBoolean(): void;
		toBeFunction(): void;
		toBeArray(): void;
		toBeTrue(): void;
		toBeFalse(): void;
		toStartWith(prefix: string): void;
		toEndWith(suffix: string): void;
	}
}

/**
 * Bun-only matchers.
 *
 * `bun:test` shipped `toBeNumber`, `toStartWith`, and friends; Vitest keeps the
 * Jest core and lets suites extend it. Registering them here keeps every
 * migrated assertion spelled the way the suite wrote it.
 */
expect.extend({
	toBeNumber(received: unknown) {
		return { pass: typeof received === "number", message: () => `expected ${String(received)} to be a number` };
	},
	toBeString(received: unknown) {
		return { pass: typeof received === "string", message: () => `expected ${String(received)} to be a string` };
	},
	toBeBoolean(received: unknown) {
		return { pass: typeof received === "boolean", message: () => `expected ${String(received)} to be a boolean` };
	},
	toBeFunction(received: unknown) {
		return { pass: typeof received === "function", message: () => `expected ${String(received)} to be a function` };
	},
	toBeArray(received: unknown) {
		return { pass: Array.isArray(received), message: () => `expected ${String(received)} to be an array` };
	},
	toBeTrue(received: unknown) {
		return { pass: received === true, message: () => `expected ${String(received)} to be true` };
	},
	toBeFalse(received: unknown) {
		return { pass: received === false, message: () => `expected ${String(received)} to be false` };
	},
	toStartWith(received: string, prefix: string) {
		return {
			pass: typeof received === "string" && received.startsWith(prefix),
			message: () => `expected ${JSON.stringify(received)} to start with ${JSON.stringify(prefix)}`,
		};
	},
	toEndWith(received: string, suffix: string) {
		return {
			pass: typeof received === "string" && received.endsWith(suffix),
			message: () => `expected ${JSON.stringify(received)} to end with ${JSON.stringify(suffix)}`,
		};
	},
});

/**
 * Bun's `mock()` factory: create a mock function with optional implementation.
 *
 * `mock.module` maps onto `vi.mock`; note that Vitest hoists module mocks, so a
 * factory that captures test-local variables needs `vi.doMock` instead.
 */
export const mock = Object.assign(
	<T extends (...args: never[]) => unknown>(implementation?: T) => vi.fn<T>(implementation),
	{
		module: (specifier: string, factory: () => unknown) => {
			// Vitest's overloads pick the module-factory shape at runtime; the
			// cast only bridges the declaration's narrower second parameter.
			const moduleFactory = factory as never;
			vi.mock(specifier, moduleFactory);
		},
		restore: () => vi.restoreAllMocks(),
		clearAllMocks: () => vi.clearAllMocks(),
		resetAllMocks: () => vi.resetAllMocks(),
	},
);
