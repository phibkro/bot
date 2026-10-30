import { passRecordFor } from "./record.ts";
import type {
  CheckEntry,
  MainRelation,
  MergeFacts,
  MergeVerdict,
  RefuseReason,
} from "./types.ts";

const refuse = (reason: RefuseReason): MergeVerdict => ({
  _tag: "Refuse",
  reason,
});

/** The squash subject is a Conventional Commit subject (V5): `type(scope)!: summary`. */
const conventionalTitle =
  /^(?:feat|fix|docs|chore|refactor|test|ci|build|perf|style|revert)(?:\([^()\n]+\))?!?: \S.*$/u;

/** `merge.sh` rule 2: an entry is green when its conclusion is SUCCESS, SKIPPED or NEUTRAL. */
const greenConclusions: ReadonlySet<string> = new Set([
  "SUCCESS",
  "SKIPPED",
  "NEUTRAL",
]);

const isSettled = (entry: CheckEntry): boolean =>
  entry.kind === "status_context" || entry.status === "completed";

/**
 * A commit status has no `conclusion`, so `merge.sh`'s `jq` counts it as not green (INFERENCE in the spec, D3; the bot fails
 * closed until a real rollup says otherwise). A check run is red when it completed with a conclusion that is not green.
 */
const isRed = (entry: CheckEntry): boolean =>
  entry.kind === "status_context" ||
  (entry.status === "completed" &&
    !greenConclusions.has(entry.conclusion ?? ""));

/** V4, added to rule 2: each required name has a completed run from `github-actions` that concluded SUCCESS. */
const requiredChecksPass = (
  required: readonly string[],
  checks: readonly CheckEntry[]
): boolean =>
  checks.length > 0 &&
  required.every((name) =>
    checks.some(
      (entry) =>
        entry.kind === "check_run" &&
        entry.name === name &&
        entry.appSlug === "github-actions" &&
        entry.status === "completed" &&
        entry.conclusion === "SUCCESS"
    )
  );

/** Rules 4 and 5 of `merge.sh`, in its order: conflicts (exit 2) before overlap (exit 3). Unknown never merges. */
const decideMain = (
  main: MainRelation,
  verdict: MergeVerdict
): MergeVerdict => {
  if (main._tag === "Ancestor") {
    return verdict;
  }

  if (main.conflicts === "yes") {
    return refuse("ConflictsWithMain");
  }

  if (main.conflicts === "unknown") {
    return main.mergeabilityExhausted
      ? refuse("Unknown")
      : { _tag: "Wait", reason: "MergeabilityUnknown" };
  }

  if (!main.mainFiles.complete || !main.headFiles.complete) {
    return refuse("Unknown");
  }

  const onMain = new Set(main.mainFiles.names);

  return main.headFiles.names.some((name) => onMain.has(name))
    ? refuse("OverlapsMain")
    : verdict;
};

/** Gates that `merge.sh` does not have (V5, V6, V7, D2): checked first, because a refusal here needs no other fact. */
const gateRefusal = (facts: MergeFacts): RefuseReason | undefined => {
  const { pr } = facts;

  if (facts.repositoryHeld) {
    return "Held";
  }

  if (!facts.rulesPinned) {
    return "RulesDrifted";
  }

  if (
    !pr.open ||
    pr.draft ||
    !pr.sameRepository ||
    !pr.baseIsDefaultBranch ||
    !conventionalTitle.test(pr.title)
  ) {
    return "PrState";
  }

  return pr.inStack ? "Stacked" : undefined;
};

/**
 * `decideMerge` (spec 0000, D1): the merge rules, in the order `merge.sh` evaluates them (record, CI, head moved, conflicts,
 * overlap), with the eight declared deviations V1 to V8 as tightenings. It is total and deterministic; the contract table
 * (`test/contractTable.ts`) runs the real `merge.sh` against it.
 */
export const decideMerge = (facts: MergeFacts): MergeVerdict => {
  const gate = gateRefusal(facts);

  if (gate !== undefined) {
    return refuse(gate);
  }

  const { pr } = facts;

  // Rule 1, with V1, V2, V3 and V8.
  const record = passRecordFor(pr.headSha, facts.operatorIds, facts.records);

  if (record._tag === "Author") {
    return refuse("RecordAuthor");
  }

  if (record._tag === "Changed") {
    return refuse("RecordChanged");
  }

  if (record._tag === "None") {
    return refuse("NoPassRecord");
  }

  // Rule 2, then V4 on top of it. A red entry refuses at once; an unsettled one waits for the event that settles it.
  if (facts.checks.some(isRed)) {
    return refuse("CiNotGreen");
  }

  if (!facts.checks.every(isSettled)) {
    return { _tag: "Wait", reason: "CiPending" };
  }

  if (!requiredChecksPass(facts.requiredChecks, facts.checks)) {
    return refuse("RequiredCheckMissing");
  }

  // Rule 3.
  if (pr.headRecheckSha !== pr.headSha) {
    return refuse("HeadMoved");
  }

  // Rules 4 and 5, then rule 6.
  return decideMain(facts.main, {
    _tag: "Merge",
    sha: pr.headSha,
    subject: `${pr.title} (#${pr.number})`,
  });
};
