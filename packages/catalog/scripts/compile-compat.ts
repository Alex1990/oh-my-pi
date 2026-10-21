/**
 * `pnpm run gen:compat` — compiles `src/compat/rules/` into
 * `src/compat/rules.json`, the committed compiled form the runtime engine
 * imports. Mirrors the models.json discipline: deterministic output,
 * regenerate + commit together with rule changes.
 */
import * as path from "node:path";
import { compileCompatRules, renderAuthIds, renderProviderIds } from "./compat-compiler";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const rulesDir = path.join(import.meta.dirname, "../src/compat/rules");
const outPath = path.join(import.meta.dirname, "../src/compat/rules.json");
const authIdsPath = path.join(import.meta.dirname, "../src/compat/auth-ids.ts");
const providerIdsPath = path.join(import.meta.dirname, "../src/compat/provider-ids.ts");

const compiled = await compileCompatRules(rulesDir);
await bun.write(outPath, JSON.stringify(compiled));
await bun.write(authIdsPath, renderAuthIds(compiled.auth));
await bun.write(providerIdsPath, renderProviderIds(compiled.providers));
console.log(
	`wrote ${path.relative(process.cwd(), outPath)} (${compiled.cascade.rules.length} rules, ${compiled.taxonomy.classes.length} classes, ${Object.keys(compiled.providers).length} catalog providers, ${compiled.auth.providers.length} auth providers, ${compiled.files.length} files)`,
);
