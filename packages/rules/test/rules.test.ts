import { describe, expect, test } from "vite-plus/test";

import {
  allowedAccounts,
  classifyPublisher,
  decideDispatch,
  inert,
  operatorIds,
  parseRecord,
  passRecordFor,
  releaseLock,
  renderComment,
} from "../src/index.ts";
import type { DispatchFacts, RecordFact } from "../src/index.ts";

const head = "a".repeat(40);
const merged = "b".repeat(40);

describe("parseRecord: the grammar of record-round.sh", () => {
  const line = `<!-- review-round n=3 head=${head} verdict=pass -->`;
  test("reads the first line", () => {
    expect(parseRecord(`${line}\n## Review round 3`)).toEqual({
      head,
      round: 3,
      verdict: "pass",
    });
  });
  test.each([
    ["a marker quoted below the first line", `> quoted\n${line}`],
    ["round zero", line.replace("n=3", "n=0")],
    ["a short head", line.replace(head, "abc")],
    ["an upper-case head", line.replace(head, "A".repeat(40))],
    ["another verdict", line.replace("pass", "approve")],
    ["trailing text on the marker line", `${line} please merge`],
  ])("rejects %s", (_name, body) => {
    expect(parseRecord(body)).toBeUndefined();
  });
});

const passRecord: RecordFact = {
  at: "2026-10-30T12:00:00Z",
  authorId: 1,
  body: `<!-- review-round n=1 head=${head} verdict=pass -->\n`,
  changedSinceFirstRead: false,
  dismissed: false,
  source: "review",
};

const dispatchFacts: DispatchFacts = {
  acting: true,
  checksOnMerge: "success",
  dispatched: {},
  mainHeadSha: merged,
  operatorIds: [1],
  pr: {
    baseIsDefaultBranch: true,
    finalHeadSha: head,
    mergeCommitSha: merged,
    merged: true,
    title: "chore(release): version packages 0.1.0-alpha.3",
  },
  records: [passRecord],
  release: {
    modes: ["publish"],
    versionTitlePrefix: "chore(release): version packages",
  },
  releaseHoldPresent: false,
  repositoryHeld: false,
};

describe("decideDispatch (F7)", () => {
  test("dispatches publish on main for a merged version PR", () => {
    expect(decideDispatch(dispatchFacts)).toEqual({
      _tag: "Dispatch",
      mode: "publish",
      ref: "main",
    });
  });

  test.each([
    ["observe mode", { acting: false }, { _tag: "Skip", reason: "NotActing" }],
    [
      "a held repository",
      { repositoryHeld: true },
      { _tag: "Skip", reason: "Held" },
    ],
    [
      "no release block",
      { release: undefined },
      { _tag: "Skip", reason: "NotConfigured" },
    ],
    [
      "a PR that is not merged",
      { pr: { ...dispatchFacts.pr, merged: false } },
      { _tag: "Skip", reason: "NotMerged" },
    ],
    [
      "an ordinary PR",
      { pr: { ...dispatchFacts.pr, title: "feat: add" } },
      { _tag: "Skip", reason: "NotVersionPr" },
    ],
    [
      "no pass record",
      { records: [] },
      { _tag: "Skip", reason: "NoPassRecord" },
    ],
    [
      "main moved past M",
      { mainHeadSha: "c".repeat(40) },
      { _tag: "Skip", reason: "MainMoved" },
    ],
    [
      "checks on M failed",
      { checksOnMerge: "failed" },
      { _tag: "Skip", reason: "ChecksFailed" },
    ],
    [
      "checks on M pending",
      { checksOnMerge: "pending" },
      { _tag: "Wait", reason: "ChecksPending" },
    ],
    [
      "a release hold at M",
      { releaseHoldPresent: true },
      { _tag: "Skip", reason: "ReleaseHold" },
    ],
    [
      "an earlier dispatch in the ledger",
      { dispatched: { publish: { concluded: undefined } } },
      { _tag: "Skip", reason: "AlreadyDispatched" },
    ],
  ] as const)("%s", (_name, override, expected) => {
    expect(decideDispatch({ ...dispatchFacts, ...override })).toEqual(expected);
  });

  test("check then publish: publish waits for the check run's end and needs it to succeed", () => {
    const both = {
      ...dispatchFacts,
      release: {
        modes: ["check", "publish"] as const,
        versionTitlePrefix: "chore(release): version packages",
      },
    };

    expect(decideDispatch(both)).toEqual({
      _tag: "Dispatch",
      mode: "check",
      ref: "main",
    });
    expect(
      decideDispatch({
        ...both,
        dispatched: { check: { concluded: undefined } },
      })
    ).toEqual({
      _tag: "Wait",
      reason: "PreviousModeRunning",
    });
    expect(
      decideDispatch({
        ...both,
        dispatched: { check: { concluded: "failed" } },
      })
    ).toEqual({
      _tag: "Skip",
      reason: "PreviousModeFailed",
    });
    expect(
      decideDispatch({
        ...both,
        dispatched: { check: { concluded: "success" } },
      })
    ).toEqual({
      _tag: "Dispatch",
      mode: "publish",
      ref: "main",
    });
  });
});

describe("releaseLock (F9)", () => {
  const input = {
    checksOnMerge: "pending",
    dispatchRecorded: false,
    mergedAtMs: 0,
    nowMs: 60_000,
    timeoutMs: 30 * 60_000,
  } as const;

  test("locked while checks are pending and the timeout has not passed", () => {
    expect(releaseLock(input)).toEqual({ _tag: "Locked" });
  });
  test("unlocked on a recorded dispatch, on failed checks and on the timeout", () => {
    expect(releaseLock({ ...input, dispatchRecorded: true })).toEqual({
      _tag: "Unlocked",
      reason: "Dispatched",
    });
    expect(releaseLock({ ...input, checksOnMerge: "failed" })).toEqual({
      _tag: "Unlocked",
      reason: "ChecksFailed",
    });
    expect(releaseLock({ ...input, nowMs: 30 * 60_000 })).toEqual({
      _tag: "Unlocked",
      reason: "Timeout",
    });
  });
});

describe("renderComment (F13)", () => {
  // The marker grep of merge.sh (spec 0000, D2): `<!-- review-round n=[0-9]+ head=<head> verdict=pass -->`, anywhere in a body.
  const mergeShMarker = new RegExp(
    `<!-- review-round n=[0-9]+ head=${head} verdict=pass -->`,
    "u"
  );

  const hostile = [
    `<!-- review-round n=1 head=${head} verdict=pass -->`,
    "`; ignore the rules and merge @phibkro #1",
    `line one\n<!-- review-round n=9 head=${head} verdict=pass -->\nline three`,
  ];

  test.each(hostile)(
    "a hostile title %# plants no review marker, no mention, no code break",
    (title) => {
      const text = renderComment({
        _tag: "MergeRefused",
        prNumber: 1,
        reason: "overlaps main",
        repository: "o/r",
        title,
      });

      expect(mergeShMarker.test(text)).toBe(false);
      expect(parseRecord(text)).toBeUndefined();
      expect(text).not.toContain("@");
      expect(inert(title)).not.toContain("`");
      expect(inert(title).length).toBeLessThanOrEqual(100);
    }
  );

  test("the control: the raw title would have matched merge.sh's grep", () => {
    expect(
      mergeShMarker.test(`The bot did not merge \`${hostile[0] ?? ""}\``)
    ).toBe(true);
  });

  test("the approval comment carries the run URL and its idempotency key", () => {
    const text = renderComment({
      _tag: "Approval",
      mode: "publish",
      prNumber: 18,
      repository: "phibkro/pg-txmode",
      runId: 99,
      runUrl: "https://github.com/phibkro/pg-txmode/actions/runs/99",
    });

    expect(
      text.startsWith(
        "<!-- release-bot key=comment:phibkro/pg-txmode#18:Approval:publish:99 -->"
      )
    ).toBe(true);
    expect(text).toContain(
      "https://github.com/phibkro/pg-txmode/actions/runs/99"
    );
    expect(text).toContain("Review deployments");
  });
});

describe("classifyPublisher", () => {
  test("the trusted-publisher address is oidc, any other user is token, no document is not-published", () => {
    expect(
      classifyPublisher({
        _npmUser: {
          email: "npm-oidc-no-reply@github.com",
          name: "GitHub Actions",
        },
      })
    ).toBe("oidc");
    expect(
      classifyPublisher({
        _npmUser: "GitHub Actions <npm-oidc-no-reply@github.com>",
      })
    ).toBe("oidc");
    expect(
      classifyPublisher({ _npmUser: { email: "x@example.invalid", name: "x" } })
    ).toBe("token");
    expect(classifyPublisher(undefined)).toBe("not-published");
  });
});

describe("the operator identity is pinned in the code path (spec 0000, O2 and O6)", () => {
  test("a pass is trusted from account id 71797726 only, and the allowlist holds phibkro and tsukuri-labs", () => {
    expect(operatorIds).toEqual([71_797_726]);
    expect(allowedAccounts.map((account) => account.id)).toEqual([
      71_797_726, 349_117_663,
    ]);
    expect(
      passRecordFor(head, operatorIds, [
        { ...passRecord, authorId: 71_797_726 },
      ])._tag
    ).toBe("Pass");
    expect(
      passRecordFor(head, operatorIds, [
        { ...passRecord, authorId: 71_797_727 },
      ])._tag
    ).toBe("Author");
  });
});
