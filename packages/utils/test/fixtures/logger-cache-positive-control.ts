import * as fs from "node:fs";
import { snapshotLoggerRuntime } from "./logger-cache-snapshot";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("expected output path");

// Dynamic so the snapshot module installs its load hook before the direct import.
await import("../../src/logger/rotating-file");

fs.writeFileSync(outputPath, JSON.stringify(snapshotLoggerRuntime()));
