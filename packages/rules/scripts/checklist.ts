// Writes docs/operator-checklist.md from the App registration data, or (--check) fails when the committed file differs.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { renderChecklist } from "../src/index.ts";

const target = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "docs",
  "operator-checklist.md"
);

const rendered = renderChecklist();

if (process.argv.includes("--check")) {
  const committed = readFileSync(target, "utf-8");

  if (committed === rendered) {
    process.stdout.write("operator checklist is up to date\n");
  } else {
    process.stderr.write(
      "docs/operator-checklist.md differs from its source: run `bun packages/rules/scripts/checklist.ts`\n"
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(target, rendered);
  process.stdout.write(`wrote ${target}\n`);
}
