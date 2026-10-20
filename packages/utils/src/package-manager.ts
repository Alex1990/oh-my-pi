/**
 * Package-manager invocations for runtime installs.
 *
 * Bun's CLI doubled as a package manager (`bun install`/`bun add`), including
 * through a compiled binary via `BUN_BE_BUN`. On Node the equivalent is pnpm
 * when it is on `PATH`, otherwise npm (which ships with Node). This module is
 * the single place that maps Bun-style install arguments onto either.
 */
import { which } from "./node-runtime";

export type PackageManagerKind = "pnpm" | "npm";

export interface PackageManager {
	readonly command: string;
	readonly kind: PackageManagerKind;
}

/** Resolve pnpm, falling back to the npm bundled with Node. */
export function resolvePackageManager(): PackageManager {
	const pnpm = which("pnpm");
	if (pnpm) return { command: pnpm, kind: "pnpm" };
	return { command: which("npm") ?? "npm", kind: "npm" };
}

/** `install` arguments for a production install (no dev dependencies). */
export function productionInstallArgs(kind: PackageManagerKind): string[] {
	return kind === "pnpm" ? ["install", "--prod", "--ignore-scripts"] : ["install", "--omit=dev", "--ignore-scripts"];
}

/** `add` arguments for installing packages into an existing manifest. */
export function addArgs(kind: PackageManagerKind, packages: readonly string[]): string[] {
	return kind === "pnpm" ? ["add", "--ignore-scripts", ...packages] : ["install", "--ignore-scripts", ...packages];
}

/** `remove` arguments for uninstalling packages. */
export function removeArgs(kind: PackageManagerKind, packages: readonly string[]): string[] {
	return kind === "pnpm" ? ["remove", ...packages] : ["uninstall", ...packages];
}

/** Translate the subset of `bun` package-manager commands this repo used. */
export function translateBunArgs(kind: PackageManagerKind, args: readonly string[]): string[] {
	const [first, ...rest] = args;
	switch (first) {
		case "install":
			return rest.length === 0
				? ["install"]
				: addArgs(
						kind,
						rest.filter(arg => !arg.startsWith("--")),
					);
		case "add":
			return addArgs(
				kind,
				rest.filter(arg => !arg.startsWith("--")),
			);
		case "remove":
		case "uninstall":
			return removeArgs(
				kind,
				rest.filter(arg => !arg.startsWith("--")),
			);
		case "pm":
			// `bun pm cache` reported the package cache directory; pnpm/npm expose
			// theirs through `store path` / `cache dir`.
			return kind === "pnpm" ? ["store", "path"] : ["config", "get", "cache"];
		default:
			return [...args];
	}
}
