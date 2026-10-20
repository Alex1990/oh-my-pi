import * as fs from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

interface ModuleConstructorWithCache {
	readonly _cache: Record<string, object>;
}

export interface CacheFamily {
	readonly modules: number;
	readonly bytes: number;
	readonly paths: string[];
}

export interface LoggerCacheSnapshot {
	readonly rotatingFile: CacheFamily;
	readonly externalLogger: CacheFamily;
	readonly externalRotator: CacheFamily;
}

const moduleCache = (nodeModule.Module as unknown as ModuleConstructorWithCache)._cache;

/** ESM modules are absent from `Module._cache`; observe their loads through a hook. */
const esmPaths: string[] = [];
nodeModule.registerHooks({
	load(url, context, nextLoad) {
		if (url.startsWith("file:")) esmPaths.push(fileURLToPath(url));
		return nextLoad(url, context);
	},
});

function snapshotFamily(segment: string): CacheFamily {
	const paths = [...Object.keys(moduleCache), ...esmPaths]
		.map(modulePath => modulePath.replaceAll("\\", "/"))
		.filter(modulePath => modulePath.includes(segment))
		.sort();
	return {
		modules: paths.length,
		bytes: paths.reduce((total, modulePath) => total + fs.statSync(modulePath).size, 0),
		paths,
	};
}

export function snapshotLoggerRuntime(): LoggerCacheSnapshot {
	return {
		rotatingFile: snapshotFamily("/packages/utils/src/logger/rotating-file.ts"),
		externalLogger: snapshotFamily("/node_modules/winston/"),
		externalRotator: snapshotFamily("/node_modules/file-stream-rotator/"),
	};
}
