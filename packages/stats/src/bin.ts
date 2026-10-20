#!/usr/bin/env node
/**
 * `omp-stats` executable entry.
 *
 * The CLI body lives in `index.ts`; keeping the invocation here means importing
 * the package (the `oyp stats` subcommand does) never parses the host process's
 * argv.
 */
import { runStatsCli } from "./index";

await runStatsCli();
