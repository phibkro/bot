import { passRecordFor } from "./record.ts";
import type { RecordFact } from "./types.ts";

export type ReleaseMode = "check" | "publish";

export interface DispatchFacts {
  readonly repositoryHeld: boolean;
  /** The repository's rollout mode: in `observe` the bot decides and writes nothing (spec 0000, "Rollout"). */
  readonly acting: boolean;
  /** The repository's `release` block: the modes in order and the title prefix of its version PRs; absent: no release. */
  readonly release:
    | {
        readonly modes: readonly ReleaseMode[];
        readonly versionTitlePrefix: string;
      }
    | undefined;
  readonly operatorIds: readonly number[];
  readonly pr: {
    readonly title: string;
    readonly merged: boolean;
    readonly baseIsDefaultBranch: boolean;
    /** `M`, the merge commit on the default branch. */
    readonly mergeCommitSha: string | undefined;
    /** The head the PR had when it merged: the pass record names this one. */
    readonly finalHeadSha: string;
  };
  readonly records: readonly RecordFact[];
  /** The default branch's tip right now (read just before the dispatch). */
  readonly mainHeadSha: string;
  /** The `checks` check run on `M`. */
  readonly checksOnMerge: "success" | "pending" | "failed" | "absent";
  /** `.github/release-hold` exists at `M`: the workflow would fail at once. */
  readonly releaseHoldPresent: boolean;
  /** What the ledger already has, per mode of this repository and `M`: a recorded dispatch and how its run ended. */
  readonly dispatched: Readonly<
    Partial<
      Record<
        ReleaseMode,
        { readonly concluded: "success" | "failed" | undefined }
      >
    >
  >;
}

export type SkipReason =
  | "NotActing"
  | "Held"
  | "NotConfigured"
  | "NotMerged"
  | "NotVersionPr"
  | "NoPassRecord"
  | "MainMoved"
  | "ChecksFailed"
  | "ReleaseHold"
  | "AlreadyDispatched"
  | "PreviousModeFailed";

export type DispatchVerdict =
  | {
      readonly _tag: "Dispatch";
      readonly mode: ReleaseMode;
      readonly ref: "main";
    }
  | {
      readonly _tag: "Wait";
      readonly reason: "ChecksPending" | "PreviousModeRunning";
    }
  | { readonly _tag: "Skip"; readonly reason: SkipReason };

const skip = (reason: SkipReason): DispatchVerdict => ({
  _tag: "Skip",
  reason,
});

/** The next mode that the ledger has not dispatched; the one before it must have concluded `success` (two clicks for `check, publish`). */
const nextMode = (
  modes: readonly ReleaseMode[],
  dispatched: DispatchFacts["dispatched"]
): DispatchVerdict => {
  let previous: ReleaseMode | undefined;

  for (const mode of modes) {
    const entry = dispatched[mode];

    if (entry === undefined) {
      const before = previous === undefined ? undefined : dispatched[previous];

      if (before?.concluded === "failed") {
        return skip("PreviousModeFailed");
      }

      if (before !== undefined && before.concluded === undefined) {
        return { _tag: "Wait", reason: "PreviousModeRunning" };
      }

      return { _tag: "Dispatch", mode, ref: "main" };
    }

    previous = mode;
  }

  return skip("AlreadyDispatched");
};

/**
 * `decideDispatch` (spec 0000, D5): a dispatch only for a merged version PR whose final head carries a pass record by an operator
 * account, while `main` is still the merge commit and its `checks` concluded `success`, with no release hold, once per mode.
 * `ref` is always `main`.
 */
export const decideDispatch = (facts: DispatchFacts): DispatchVerdict => {
  const { pr, release } = facts;

  if (!facts.acting) {
    return skip("NotActing");
  }

  if (facts.repositoryHeld) {
    return skip("Held");
  }

  if (release === undefined) {
    return skip("NotConfigured");
  }

  if (
    !pr.merged ||
    !pr.baseIsDefaultBranch ||
    pr.mergeCommitSha === undefined
  ) {
    return skip("NotMerged");
  }

  if (!pr.title.startsWith(release.versionTitlePrefix)) {
    return skip("NotVersionPr");
  }

  if (
    passRecordFor(pr.finalHeadSha, facts.operatorIds, facts.records)._tag !==
    "Pass"
  ) {
    return skip("NoPassRecord");
  }

  if (facts.mainHeadSha !== pr.mergeCommitSha) {
    return skip("MainMoved");
  }

  if (facts.checksOnMerge === "failed") {
    return skip("ChecksFailed");
  }

  if (facts.checksOnMerge !== "success") {
    // `pending`, or `absent`: the run has not registered on `M` yet. Both wait; the lock's timeout ends the wait (D5).
    return { _tag: "Wait", reason: "ChecksPending" };
  }

  if (facts.releaseHoldPresent) {
    return skip("ReleaseHold");
  }

  return nextMode(release.modes, facts.dispatched);
};

export type LockState =
  | { readonly _tag: "Locked" }
  | {
      readonly _tag: "Unlocked";
      readonly reason: "Dispatched" | "ChecksFailed" | "Timeout";
    };

/**
 * The lock on other merges between the merge of a version PR and the dispatch (D5, F9): it ends when the dispatch is recorded,
 * when `checks` on `M` concluded without success, or when `timeoutMs` has passed with `checks` still unfinished.
 */
export const releaseLock = (input: {
  readonly dispatchRecorded: boolean;
  readonly checksOnMerge: DispatchFacts["checksOnMerge"];
  readonly mergedAtMs: number;
  readonly nowMs: number;
  readonly timeoutMs: number;
}): LockState => {
  if (input.dispatchRecorded) {
    return { _tag: "Unlocked", reason: "Dispatched" };
  }

  if (input.checksOnMerge === "failed") {
    return { _tag: "Unlocked", reason: "ChecksFailed" };
  }

  return input.nowMs - input.mergedAtMs >= input.timeoutMs
    ? { _tag: "Unlocked", reason: "Timeout" }
    : { _tag: "Locked" };
};
