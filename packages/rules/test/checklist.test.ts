import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  appEvents,
  appPermissions,
  forbiddenPermissions,
  renderChecklist,
  repositories,
  secretNames,
} from "../src/index.ts";

const committed = readFileSync(
  path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "docs",
    "operator-checklist.md"
  ),
  "utf-8"
);

describe("the operator checklist is derived from the code's own data", () => {
  test("the committed file is the rendered one (regenerate with `bun packages/rules/scripts/checklist.ts`)", () => {
    expect(committed).toBe(renderChecklist());
  });

  test("it names every permission level, event, secret name and installed repository, and no forbidden permission as granted", () => {
    for (const [, entry] of Object.entries(appPermissions)) {
      expect(committed).toContain(entry.reason);
    }

    for (const event of appEvents) {
      expect(committed).toContain(
        event === "pull_request_review"
          ? "Pull request review"
          : event
              .split("_")
              .map((word, index) =>
                index === 0 ? word[0]?.toUpperCase() + word.slice(1) : word
              )
              .join(" ")
      );
    }

    for (const name of secretNames) {
      expect(committed).toContain(name);
    }

    for (const repo of repositories) {
      expect(committed).toContain(`\`${repo.fullName.split("/")[1]}\``);
    }

    for (const name of forbiddenPermissions) {
      expect(Object.keys(appPermissions)).not.toContain(name);
    }
  });

  test("it contains no secret value: no key block, no token, no assignment of a secret name", () => {
    expect(committed).not.toMatch(
      /BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|ghs_/u
    );

    for (const name of secretNames) {
      expect(committed).not.toMatch(new RegExp(`${name}=`, "u"));
    }
  });

  test("every repository starts in observe mode (spec 0000, Rollout)", () => {
    for (const repo of repositories) {
      expect(repo.mode).toBe("observe");
    }
  });
});
