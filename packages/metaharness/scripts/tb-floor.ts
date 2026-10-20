#!/usr/bin/env bun

import * as path from "node:path";
import { main } from "../src/tb/cli";
import { bun } from "@oh-my-pi/pi-utils/node-runtime";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const args = [
	"--jobs-dir",
	bun.env.TB_JOBS_DIR ?? path.join(REPO_ROOT, "runs", "tb-floor"),
	"--concurrency",
	bun.env.TB_CONCURRENCY ?? "20",
	"--openrouter-variant",
	bun.env.TB_OPENROUTER_VARIANT ?? "floor",
];

if (bun.env.TB_DATASET) args.push("--dataset", bun.env.TB_DATASET);
if (bun.env.TB_BUDGET_USD) args.push("--budget", bun.env.TB_BUDGET_USD);
if (bun.env.TB_ATTEMPTS) args.push("--attempts", bun.env.TB_ATTEMPTS);
if (bun.env.TB_FOREVER === "1") args.push("--forever");
args.push(...process.argv.slice(2));

await main(args);
