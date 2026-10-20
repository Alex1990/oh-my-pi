/**
 * Dashboard assets for the Node server.
 *
 * Bun's dev server bundled the HTML entry (`import indexHtml from
 * "./web/index.html"`) and served the referenced TSX module with HMR. Node has
 * no HTML entry loader, so the same entry is bundled once per process with
 * esbuild — via the repository's `Bun.build` replacement — and the HTML is
 * served with a rewritten script tag pointing at the emitted bundle.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "@oh-my-pi/pi-utils/node-build";

const WEB_DIR = import.meta.dirname;
const HTML_PATH = path.join(WEB_DIR, "index.html");
const APP_ENTRY = path.join(WEB_DIR, "app.tsx");
/** The HTML references the TSX entry directly; the server serves the bundle instead. */
const APP_ENTRY_REFERENCE = 'src="./app.tsx"';
const APP_BUNDLE_PATH = "/app.js";

export interface DashboardAssets {
	/** `index.html` with the entry script retargeted at {@link APP_BUNDLE_PATH}. */
	html: string;
	/** Browser ES module bundle for the dashboard. */
	js: string;
}

async function bundleDashboard(): Promise<DashboardAssets> {
	const outdir = await fs.mkdtemp(path.join(os.tmpdir(), "metaharness-dashboard-"));
	const production = process.env.NODE_ENV === "production";
	try {
		const result = await build({
			entrypoints: [APP_ENTRY],
			outdir,
			platform: "browser",
			format: "esm",
			target: "browser",
			naming: { entry: "app.js", chunk: "[name]-[hash].js", asset: "[name]-[hash][ext]" },
			// React reads `process.env.NODE_ENV` at module scope; browser bundles
			// have no `process`, so esbuild must inline the server's mode.
			define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
			minify: production,
			logLevel: "warning",
		});
		if (!result.success) {
			const details = result.logs.map(log => log.message).join("\n");
			throw new Error(`Failed to bundle the metaharness dashboard${details ? `:\n${details}` : ""}`);
		}
		const js = await fs.readFile(path.join(outdir, "app.js"), "utf8");
		const html = await fs.readFile(HTML_PATH, "utf8");
		const referenced = html.replace(APP_ENTRY_REFERENCE, `src="${APP_BUNDLE_PATH}"`);
		if (referenced === html) {
			throw new Error(`Dashboard HTML does not reference ${APP_ENTRY_REFERENCE}`);
		}
		return { html: referenced, js };
	} finally {
		await fs.rm(outdir, { recursive: true, force: true });
	}
}

let assets: Promise<DashboardAssets> | null = null;

/** Dashboard HTML + bundle, built on first request and reused for the process lifetime. */
export function dashboardAssets(): Promise<DashboardAssets> {
	assets ??= bundleDashboard().catch(error => {
		assets = null;
		throw error;
	});
	return assets;
}
