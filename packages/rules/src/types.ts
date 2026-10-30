/** Facts and verdicts of the merge rules (spec 0000, D1 and D3). Plain data: no Effect, no I/O, no clock. */

/** One entry of the check rollup of a head. A check run has a status; a commit status has neither status nor conclusion. */
export interface CheckEntry {
  readonly kind: "check_run" | "status_context";
  readonly name: string;
  /** The GitHub App that owns a check run (`github-actions`); undefined for a commit status. */
  readonly appSlug: string | undefined;
  readonly status: "queued" | "in_progress" | "completed";
  /** Upper case, as `gh pr view --json statusCheckRollup` prints it (`SUCCESS`, `SKIPPED`, ...). */
  readonly conclusion: string | undefined;
}

/** A review body or a plain PR comment, as `merge.sh` reads them (`--json comments,reviews`). */
export interface RecordFact {
  readonly body: string;
  /** Numeric account id of the author: a login can be renamed and reclaimed, an id cannot (V1). */
  readonly authorId: number;
  readonly source: "review" | "comment";
  /** A review in state DISMISSED (V3). */
  readonly dismissed: boolean;
  /** `created_at` of a comment or `submitted_at` of a review, ISO 8601: the tie-break of V3. */
  readonly at: string;
  /** The body differs from the one the bot first read as a pass (V8); computed by the caller from the stored hash. */
  readonly changedSinceFirstRead: boolean;
}

/** A set of paths changed since the merge base. `complete` is false when the API may have cut the list. */
export interface FileSet {
  readonly complete: boolean;
  readonly names: readonly string[];
}

/** What `main` is to the head, the facts that `merge.sh` gets from `git` (rules 4 and 5, spec D1 "Where rules 4 and 5..."). */
export type MainRelation =
  | { readonly _tag: "Ancestor" }
  | {
      readonly _tag: "Moved";
      /** `yes`: the PR does not merge cleanly; `unknown`: GitHub is still computing it (`mergeable: null`). */
      readonly conflicts: "yes" | "no" | "unknown";
      /** The bounded re-reads of an unknown `mergeable` are used up. */
      readonly mergeabilityExhausted: boolean;
      readonly mainFiles: FileSet;
      readonly headFiles: FileSet;
    };

export interface PrFacts {
  readonly number: number;
  readonly title: string;
  readonly open: boolean;
  readonly draft: boolean;
  /** The reviewed head: the one the PR has when the decision starts. */
  readonly headSha: string;
  /** The head read again after the checks were read (the `merge.sh` check "head moved during CI"). */
  readonly headRecheckSha: string;
  readonly sameRepository: boolean;
  readonly baseIsDefaultBranch: boolean;
  /** The PR object has a non-null `stack` (V7). The real API omits the key when the PR is not stacked. */
  readonly inStack: boolean;
}

export interface MergeFacts {
  readonly repositoryHeld: boolean;
  /** The pinned blobs of `merge.sh`, `record-round.sh` (and `check-record.sh`) equal the live ones (D2). */
  readonly rulesPinned: boolean;
  readonly operatorIds: readonly number[];
  readonly requiredChecks: readonly string[];
  readonly pr: PrFacts;
  readonly records: readonly RecordFact[];
  readonly checks: readonly CheckEntry[];
  readonly main: MainRelation;
}

/** `merge.sh` exit codes of the refusals that it has: 4 no record or head moved, 1 CI, 2 conflicts, 3 overlap. */
export type RefuseReason =
  | "Held"
  | "RulesDrifted"
  | "PrState"
  | "Stacked"
  | "RecordAuthor"
  | "NoPassRecord"
  | "RecordChanged"
  | "CiNotGreen"
  | "RequiredCheckMissing"
  | "HeadMoved"
  | "ConflictsWithMain"
  | "OverlapsMain"
  | "Unknown";

export type WaitReason = "CiPending" | "MergeabilityUnknown";

export type MergeVerdict =
  | { readonly _tag: "Merge"; readonly sha: string; readonly subject: string }
  | { readonly _tag: "Wait"; readonly reason: WaitReason }
  | { readonly _tag: "Refuse"; readonly reason: RefuseReason };

/** The exit code `merge.sh` has for a refusal reason, when it has one (the contract table compares these). */
export const mergeShExit = (
  reason: RefuseReason
): 1 | 2 | 3 | 4 | undefined => {
  switch (reason) {
    case "NoPassRecord":
    case "HeadMoved": {
      return 4;
    }

    case "CiNotGreen": {
      return 1;
    }

    case "ConflictsWithMain": {
      return 2;
    }

    case "OverlapsMain": {
      return 3;
    }

    // Refusals the script has no exit code for (its other exits are usage errors): each named, so a new reason must choose.
    case "Held":
    case "RulesDrifted":
    case "PrState":
    case "Stacked":
    case "RecordAuthor":
    case "RecordChanged":
    case "RequiredCheckMissing":
    case "Unknown": {
      return undefined;
    }
  }
};
