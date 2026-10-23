/**
 * Release-identity guard for addons leaving the build tree (standalone binary
 * embedding and portable-archive packaging).
 *
 * The runtime loader validates the addon it dlopens against the shipping
 * package version, so an addon whose stamp slot was never filled — the normal
 * state of a raw `bazel-bin` output — produces an archive that installs
 * cleanly and dies on the first launch. Fail at packaging time instead, with
 * the file and the command that fixes it.
 */
import {
	containsLegacyVersionSentinel,
	containsVersionStamp,
	VERSION_STAMP_MAGIC,
} from "../native/version-sentinel.js";

/**
 * Throw unless `bytes` identify `version`: the post-link stamp or the legacy
 * per-release export that pre-stamp addons used (the loader accepts both).
 * @param addonPath Path to report; not read here.
 * @param bytes Addon image.
 * @param version `packages/natives/package.json#version`.
 */
export function assertAddonVersioned(addonPath: string, bytes: Uint8Array, version: string): void {
	if (containsVersionStamp(bytes, version) || containsLegacyVersionSentinel(bytes, version)) return;
	throw new Error(
		`Native addon ${addonPath} does not carry the @oh-my-pi/pi-natives@${version} version stamp ` +
			`\`${VERSION_STAMP_MAGIC}${version}\`. Rebuild it (installs stamp automatically) ` +
			`or run \`bun scripts/stamp-native-version.ts ${addonPath}\` before packaging.`,
	);
}
