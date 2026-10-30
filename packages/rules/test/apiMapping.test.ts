import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  compareFileLimit,
  decideMerge,
  fileSetFromCompare,
  mainRelationFromApi,
  maxMergeabilityReads,
  prFactsFromApi,
} from "../src/index.ts";
import type {
  ApiCompare,
  MainRelation,
  MainRelationInput,
  MergeFacts,
} from "../src/index.ts";
import type { MainKind } from "./contractTable.ts";
import { buildRepo, git } from "./gitFixtures.ts";
import type { Repo } from "./gitFixtures.ts";

/**
 * F20 (spec 0000): the API-to-fact mapping gives the verdict that the git facts of the same repository state give. The API
 * responses are computed from the real git repository (`rev-list`, `diff --name-only`, `merge-tree`) in the documented shapes.
 * They are a model of GitHub's fields, not GitHub: the fixtures captured from the real API are in the service package, and the
 * live capture on a throwaway repository is part of the F19 journey (spec 0000, Revisions 4).
 */

let root = "";
const repos = new Map<MainKind, Repo>();

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "bot-api-mapping-"));

  for (const kind of ["ancestor", "disjoint", "overlap", "conflict"] as const) {
    repos.set(kind, buildRepo(root, kind));
  }
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const compareOf = (work: string, from: string, to: string): ApiCompare => ({
  behind_by: Number(git(work, ["rev-list", "--count", `${to}..${from}`])),
  files: git(work, ["diff", "--name-only", from, to])
    .split("\n")
    .filter((name) => name !== "")
    .map((filename) => ({ filename })),
});

const mergeableOf = (work: string, head: string): boolean => {
  try {
    git(work, ["merge-tree", "--write-tree", "origin/main", head]);

    return true;
  } catch {
    return false;
  }
};

const apiRelation = (
  repo: Repo,
  overrides: Partial<MainRelationInput> = {}
): MainRelation => {
  const base = git(repo.work, ["merge-base", "origin/main", repo.head]);

  return mainRelationFromApi({
    ancestry: compareOf(repo.work, "origin/main", repo.head),
    headSince: compareOf(repo.work, base, repo.head),
    mainSince: compareOf(repo.work, base, "origin/main"),
    mergeabilityReads: 1,
    mergeable: mergeableOf(repo.work, repo.head),
    ...overrides,
  });
};

const factsWith = (relation: MainRelation, repo: Repo): MergeFacts => ({
  checks: [
    {
      appSlug: "github-actions",
      conclusion: "SUCCESS",
      kind: "check_run",
      name: "checks",
      status: "completed",
    },
  ],
  main: relation,
  operatorIds: [1],
  pr: {
    baseIsDefaultBranch: true,
    draft: false,
    headRecheckSha: repo.head,
    headSha: repo.head,
    inStack: false,
    number: 7,
    open: true,
    sameRepository: true,
    title: "feat: x",
  },
  records: [
    {
      at: "2026-10-30T12:00:00Z",
      authorId: 1,
      body: `<!-- review-round n=1 head=${repo.head} verdict=pass -->\n`,
      changedSinceFirstRead: false,
      dismissed: false,
      source: "review",
    },
  ],
  repositoryHeld: false,
  requiredChecks: ["checks"],
  rulesPinned: true,
});

describe("F20: the API facts give the git verdict", () => {
  test.each(["ancestor", "disjoint", "overlap", "conflict"] as const)(
    "%s: the mapped relation equals the git relation",
    (kind) => {
      const repo = repos.get(kind);
      expect(repo).toBeDefined();

      if (repo !== undefined) {
        expect(apiRelation(repo)).toEqual(repo.main);
      }
    }
  );

  test("mergeable null is Wait while reads remain, then Refuse(Unknown); never a merge", () => {
    const repo = repos.get("disjoint");

    if (repo === undefined) {
      throw new Error("fixture missing");
    }

    const waiting = decideMerge(
      factsWith(
        apiRelation(repo, { mergeabilityReads: 1, mergeable: null }),
        repo
      )
    );

    expect(waiting).toEqual({ _tag: "Wait", reason: "MergeabilityUnknown" });

    const exhausted = decideMerge(
      factsWith(
        apiRelation(repo, {
          mergeabilityReads: maxMergeabilityReads,
          mergeable: null,
        }),
        repo
      )
    );

    expect(exhausted).toEqual({ _tag: "Refuse", reason: "Unknown" });
  });

  test("a compare file list at the 300-entry limit is Refuse(Unknown), not a smaller set assumed complete", () => {
    const repo = repos.get("disjoint");

    if (repo === undefined) {
      throw new Error("fixture missing");
    }

    const names = Array.from({ length: compareFileLimit }, (_, index) => ({
      filename: `f${index}.txt`,
    }));

    expect(fileSetFromCompare({ behind_by: 1, files: names }).complete).toBe(
      false
    );
    expect(
      fileSetFromCompare({ behind_by: 1, files: names.slice(1) }).complete
    ).toBe(true);

    const verdict = decideMerge(
      factsWith(
        apiRelation(repo, { mainSince: { behind_by: 1, files: names } }),
        repo
      )
    );

    expect(verdict).toEqual({ _tag: "Refuse", reason: "Unknown" });
  });

  test("a rename counts its previous name as touched", () => {
    const set = fileSetFromCompare({
      behind_by: 1,
      files: [{ filename: "new.txt", previous_filename: "old.txt" }],
    });

    expect(set.names).toEqual(["new.txt", "old.txt"]);
  });

  test("the PR's stack key is optional: absent and null are not stacked, an object is", () => {
    const pull = {
      base: { ref: "main", repo: { full_name: "o/r" } },
      head: { repo: { full_name: "o/r" }, sha: "a".repeat(40) },
      number: 1,
      state: "open",
      title: "feat: x",
    };

    expect(prFactsFromApi(pull, pull.head.sha, "main").inStack).toBe(false);
    expect(
      prFactsFromApi({ ...pull, stack: null }, pull.head.sha, "main").inStack
    ).toBe(false);
    expect(
      prFactsFromApi(
        { ...pull, stack: { position: 2, size: 3 } },
        pull.head.sha,
        "main"
      ).inStack
    ).toBe(true);
  });
});
