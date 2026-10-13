#!/usr/bin/env node
import { parseArgs } from "node:util";
import { formatRunIndexMarkdown, readRunIndex } from "../dist/reader/index.js";

try {
  const { values, positionals } = parseArgs({
    options: { format: { type: "string", default: "json" }, project: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write("Usage: node bin/read-runs.mjs <state-root> [--project <name>] [--format json|markdown]\n");
  } else if (positionals.length !== 1 || !["json", "markdown"].includes(values.format)) {
    process.stderr.write("Usage: node bin/read-runs.mjs <state-root> [--project <name>] [--format json|markdown]\n");
    process.exitCode = 1;
  } else {
    const index = await readRunIndex(positionals[0], { project: values.project });
    process.stdout.write(values.format === "markdown" ? formatRunIndexMarkdown(index) : JSON.stringify(index, null, 2) + "\n");
  }
} catch {
  // Do not expose argument values, absolute state paths or filesystem error messages.
  process.stderr.write("Unable to read run index. Check the arguments and build the reader first.\n");
  process.exitCode = 1;
}
