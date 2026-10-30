import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { MainRelation } from "../src/index.ts";
import type { MainKind } from "./contractTable.ts";

/** Real temporary git repositories for the contract tests (F10) and the API-mapping tests (F20). */

export const git = (cwd: string, args: readonly string[]): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=contract-test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf-8" }
  ).trim();

export const lines = (changed: ReadonlyMap<number, string>): string =>
  `${Array.from({ length: 20 }, (_, index) => changed.get(index + 1) ?? `line ${index + 1}`).join("\n")}\n`;

export interface Repo {
  readonly work: string;
  readonly head: string;
  readonly old: string;
  readonly main: MainRelation;
}

/** One repository per kind of `main`: a PR commit that changes line 2 of `a.txt`, and a commit on `main` that differs by kind. */
export const buildRepo = (root: string, kind: MainKind): Repo => {
  const origin = path.join(root, `${kind}-origin.git`);
  const work = path.join(root, `${kind}-work`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
  git(work, ["checkout", "-q", "-b", "main"]);
  writeFileSync(path.join(work, "a.txt"), lines(new Map()));
  writeFileSync(path.join(work, "c.txt"), "c\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-q", "-m", "base"]);
  git(work, ["push", "-q", "origin", "main"]);
  const old = git(work, ["rev-parse", "HEAD"]);
  git(work, ["checkout", "-q", "-b", "pr"]);
  writeFileSync(
    path.join(work, "a.txt"),
    lines(new Map([[2, "line 2 from the PR"]]))
  );
  git(work, ["commit", "-q", "-am", "pr"]);
  const head = git(work, ["rev-parse", "HEAD"]);

  if (kind !== "ancestor") {
    git(work, ["checkout", "-q", "main"]);

    if (kind === "disjoint") {
      writeFileSync(path.join(work, "c.txt"), "c changed on main\n");
    } else {
      const change =
        kind === "overlap"
          ? new Map([[19, "line 19 from main"]])
          : new Map([[2, "line 2 from main"]]);

      writeFileSync(path.join(work, "a.txt"), lines(change));
    }

    git(work, ["commit", "-q", "-am", "main moved"]);
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["checkout", "-q", "pr"]);
  }

  return { head, main: mainRelation(work, head), old, work };
};

/** The facts `merge.sh` gets from `git` (rules 4 and 5), computed with the same commands. */
export const mainRelation = (work: string, head: string): MainRelation => {
  const ancestor = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", "origin/main", head],
    { cwd: work }
  );

  if (ancestor.status === 0) {
    return { _tag: "Ancestor" };
  }

  const mergeBase = git(work, ["merge-base", "origin/main", head]);

  const names = (to: string): readonly string[] =>
    git(work, ["diff", "--name-only", mergeBase, to])
      .split("\n")
      .filter((name) => name !== "");

  const tree = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "origin/main", head],
    { cwd: work }
  );

  return {
    _tag: "Moved",
    conflicts: tree.status === 0 ? "no" : "yes",
    headFiles: { complete: true, names: names(head) },
    mainFiles: { complete: true, names: names("origin/main") },
    mergeabilityExhausted: false,
  };
};
