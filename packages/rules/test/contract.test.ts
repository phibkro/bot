import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  decideMerge,
  mergeShExit,
  operatorIds,
  parseRecord,
} from "../src/index.ts";
import type {
  CheckEntry,
  MergeFacts,
  MergeVerdict,
  RecordFact,
} from "../src/index.ts";
import { rows } from "./contractTable.ts";
import type { CheckSpec, MainKind, RecordSpec, Row } from "./contractTable.ts";
import { buildRepo } from "./gitFixtures.ts";
import type { Repo } from "./gitFixtures.ts";

/**
 * F10 (spec 0000): `decideMerge` against the real `merge.sh`. The script runs in a real temporary git repository; only `gh`
 * is a stub, and it serves the JSON a row describes through the script's own `--jq` filters (real `jq`). The facts of
 * `decideMerge` are computed from the same git repository, so this proves the rules on git-shaped facts. It cannot prove the
 * API-to-fact mapping: that is F20 (`packages/service/test/apiMapping.test.ts`).
 */

const here = import.meta.dirname;
const canonicalMergeSh = path.join(here, "fixtures", "merge.sh");
const repoRoot = path.resolve(here, "..", "..", "..");
const vendoredScripts = path.join(repoRoot, ".agents", "skills", "review-pr");

const marker = (round: number, head: string, verdict: string): string =>
  `<!-- review-round n=${round} head=${head} verdict=${verdict} -->`;

const bodyOf = (spec: RecordSpec, repo: Repo): string => {
  const line = marker(
    spec.round,
    spec.head === "H" ? repo.head : repo.old,
    spec.verdict
  );

  return spec.quoted === true
    ? `> a reviewer quoting an earlier round\n${line}\n`
    : `${line}\n## Review round ${spec.round}\n`;
};

const stubGh = `#!/usr/bin/env bash
case "$1 $2" in
  "pr view")
    shift 3
    json=""; jqf=""
    while [ $# -gt 0 ]; do
      case "$1" in --json) json=$2; shift 2;; --jq) jqf=$2; shift 2;; *) shift;; esac
    done
    if [ "$json" = headRefOid ]; then
      c=$(cat "$STUB_COUNT" 2>/dev/null || echo 0); c=$((c + 1)); echo "$c" >"$STUB_COUNT"
      if [ "$c" -ge 2 ] && [ "$STUB_MOVES" = 1 ]; then head=$STUB_HEAD_B; else head=$STUB_HEAD_A; fi
      doc=$(jq -n --arg h "$head" '{headRefOid: $h}')
    else
      doc=$(cat "$STUB_FIXTURE")
    fi
    if [ -n "$jqf" ]; then printf '%s' "$doc" | jq -r "$jqf"; else printf '%s' "$doc"; fi ;;
  "pr checks") exit 0 ;;
  "pr merge") : >"$STUB_MERGED"; echo "merged"; exit 0 ;;
  "pr review") cat >"$STUB_REVIEW"; exit 0 ;;
  *) echo "gh stub: unexpected: $*" >&2; exit 99 ;;
esac
`;

const rollupEntry = (check: Row["scenario"]["checks"][number]): object =>
  check.statusContext === true
    ? { __typename: "StatusContext", context: check.name, state: "SUCCESS" }
    : {
        __typename: "CheckRun",
        conclusion: check.conclusion ?? "SUCCESS",
        name: check.name,
        status: (check.status ?? "completed").toUpperCase(),
      };

let root = "";
const repos = new Map<MainKind, Repo>();

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "bot-contract-"));

  for (const kind of ["ancestor", "disjoint", "overlap", "conflict"] as const) {
    repos.set(kind, buildRepo(root, kind));
  }

  mkdirSync(path.join(root, "bin"));
  writeFileSync(path.join(root, "bin", "gh"), stubGh);
  chmodSync(path.join(root, "bin", "gh"), 0o755);
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

const appSlugOf = (check: CheckSpec): string | undefined => {
  if (check.statusContext === true) {
    return undefined;
  }

  return check.app === "other" ? "other-app" : "github-actions";
};

const runMergeSh = (row: Row, repo: Repo): "merge" | number => {
  const { scenario } = row;
  const dir = path.join(root, `run-${row.id}`);
  mkdirSync(dir);

  const reviews = scenario.records
    .filter((spec) => spec.source === "review")
    .map((spec) => ({ body: bodyOf(spec, repo) }));

  const comments = scenario.records
    .filter((spec) => spec.source === "comment")
    .map((spec) => ({ body: bodyOf(spec, repo) }));

  writeFileSync(
    path.join(dir, "fixture.json"),
    JSON.stringify({
      comments,
      reviews,
      statusCheckRollup: scenario.checks.map((check) => rollupEntry(check)),
    })
  );

  const result = spawnSync("bash", [canonicalMergeSh, "7", scenario.title], {
    cwd: repo.work,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
      STUB_COUNT: path.join(dir, "count"),
      STUB_FIXTURE: path.join(dir, "fixture.json"),
      STUB_HEAD_A: repo.head,
      STUB_HEAD_B: repo.old,
      STUB_MERGED: path.join(dir, "merged"),
      STUB_MOVES: scenario.headMoves ? "1" : "0",
      STUB_REVIEW: path.join(dir, "review"),
    },
  });

  if (result.status === 0) {
    return existsSync(path.join(dir, "merged")) ? "merge" : 0;
  }

  return result.status ?? -1;
};

const factsOf = (row: Row, repo: Repo): MergeFacts => {
  const { scenario } = row;

  const records: readonly RecordFact[] = scenario.records.map(
    (spec, index) => ({
      at: `2026-10-30T12:00:0${index}Z`,
      authorId: spec.author === "operator" ? (operatorIds[0] ?? 0) : 1,
      body: bodyOf(spec, repo),
      changedSinceFirstRead: spec.changed === true,
      dismissed: spec.dismissed === true,
      source: spec.source,
    })
  );

  const checks: readonly CheckEntry[] = scenario.checks.map((check) => ({
    appSlug: appSlugOf(check),
    conclusion:
      check.statusContext === true
        ? undefined
        : (check.conclusion ?? "SUCCESS"),
    kind: check.statusContext === true ? "status_context" : "check_run",
    name: check.name,
    status:
      check.statusContext === true
        ? "completed"
        : (check.status ?? "completed"),
  }));

  return {
    checks,
    main: repo.main,
    operatorIds,
    pr: {
      baseIsDefaultBranch: scenario.baseIsDefault,
      draft: scenario.draft,
      headRecheckSha: scenario.headMoves ? repo.old : repo.head,
      headSha: repo.head,
      inStack: scenario.stack,
      number: 7,
      open: true,
      sameRepository: !scenario.fork,
      title: scenario.title,
    },
    records,
    repositoryHeld: scenario.held,
    requiredChecks: scenario.requiredChecks,
    rulesPinned: true,
  };
};

const render = (verdict: MergeVerdict): string =>
  verdict._tag === "Merge" ? "Merge" : `${verdict._tag}:${verdict.reason}`;

describe("contract table: the real merge.sh against decideMerge", () => {
  test.each(rows)(
    "$id: merge.sh and decideMerge give the table's outcomes",
    (row) => {
      const repo = repos.get(row.scenario.main);
      expect(repo).toBeDefined();

      if (repo === undefined) {
        return;
      }

      expect(runMergeSh(row, repo)).toBe(row.mergeSh);
      const verdict = decideMerge(factsOf(row, repo));
      expect(render(verdict)).toBe(row.verdict);

      if (row.kind === "base") {
        // Base rows agree with the script: merge is exit 0, Wait is the script's CI exit, a refusal has its exit code.
        if (verdict._tag === "Merge") {
          expect(row.mergeSh).toBe("merge");
        } else if (verdict._tag === "Wait") {
          expect(row.mergeSh).toBe(1);
        } else {
          expect(mergeShExit(verdict.reason)).toBe(row.mergeSh);
        }
      } else {
        // Deviation rows are tightenings: the script merges and the function refuses.
        expect(row.mergeSh).toBe("merge");
        expect(verdict._tag).toBe("Refuse");
      }
    }
  );
});

describe("the vendored scripts are the pinned ones", () => {
  test("the canonical fixture is the file that all five repositories hash to (spec 0000, D1)", () => {
    const digest = createHash("sha256")
      .update(readFileSync(canonicalMergeSh))
      .digest("hex");

    expect(digest).toBe(
      "3819dd69d3eb81daba092d01e9558cae5d101cace3ee1a2093054804d2248236"
    );
  });

  test("this repository's merge.sh is the canonical file with a provenance line", () => {
    const vendored = readFileSync(
      path.join(vendoredScripts, "merge.sh"),
      "utf-8"
    )
      .split("\n")
      .filter((line) => !line.startsWith("# Provenance:"))
      .join("\n");

    expect(vendored).toBe(readFileSync(canonicalMergeSh, "utf-8"));
  });

  test.each(["pass", "changes"])(
    "record-round.sh writes a first line that parseRecord reads back (%s)",
    (verdict) => {
      const repo = repos.get("ancestor");
      expect(repo).toBeDefined();

      if (repo === undefined) {
        return;
      }

      const dir = path.join(root, `record-${verdict}`);
      mkdirSync(dir);
      const body = path.join(dir, "body.md");
      writeFileSync(
        body,
        "Author: writer\nReviewers: reviewer\nChecked: plan, implementation, agreement\n"
      );

      const result = spawnSync(
        "bash",
        [
          path.join(vendoredScripts, "record-round.sh"),
          "7",
          "3",
          verdict,
          body,
        ],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}`,
            STUB_COUNT: path.join(dir, "count"),
            STUB_HEAD_A: repo.head,
            STUB_HEAD_B: repo.head,
            STUB_MOVES: "0",
            STUB_REVIEW: path.join(dir, "review"),
          },
        }
      );

      expect(result.status).toBe(0);
      const posted = readFileSync(path.join(dir, "review"), "utf-8");
      expect(parseRecord(posted)).toEqual({
        head: repo.head,
        round: 3,
        verdict,
      });
    }
  );
});
