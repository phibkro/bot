/**
 * The Contract table of spec 0000 (D3): the oracle of F10. Each row is a scenario, the outcome of the real `merge.sh` on it,
 * and the verdict of `decideMerge`. Base rows (M) must agree; deviation rows (X) assert that `merge.sh` merges and `decideMerge`
 * refuses, so removing a deviation fails the test. Add rows, never remove one without a Revisions entry.
 */

export type MainKind = "ancestor" | "disjoint" | "overlap" | "conflict";

export interface RecordSpec {
  readonly round: number;
  readonly verdict: "pass" | "changes";
  readonly head: "H" | "old";
  readonly author: "operator" | "stranger";
  readonly source: "review" | "comment";
  readonly dismissed?: boolean;
  /** The marker sits below a first line of quoted text (V2). */
  readonly quoted?: boolean;
  /** The body changed since the bot first read it (V8). */
  readonly changed?: boolean;
}

export interface CheckSpec {
  readonly name: string;
  readonly app?: "github-actions" | "other";
  readonly status?: "completed" | "in_progress";
  readonly conclusion?: string | undefined;
  readonly statusContext?: boolean;
}

export interface Scenario {
  readonly main: MainKind;
  readonly records: readonly RecordSpec[];
  readonly checks: readonly CheckSpec[];
  readonly headMoves: boolean;
  readonly requiredChecks: readonly string[];
  readonly held: boolean;
  readonly title: string;
  readonly draft: boolean;
  readonly fork: boolean;
  readonly baseIsDefault: boolean;
  readonly stack: boolean;
}

/** What `merge.sh` does: merge, or exit with the code of its first failing rule. */
export type MergeShOutcome = "merge" | 1 | 2 | 3 | 4;

export interface Row {
  readonly id: string;
  readonly kind: "base" | "deviation";
  readonly scenario: Scenario;
  readonly mergeSh: MergeShOutcome;
  /** `Merge`, `Wait:<reason>` or `Refuse:<reason>`. */
  readonly verdict: string;
}

const pass: RecordSpec = {
  author: "operator",
  head: "H",
  round: 1,
  source: "review",
  verdict: "pass",
};

const green: CheckSpec = {
  app: "github-actions",
  conclusion: "SUCCESS",
  name: "checks",
};

const base: Scenario = {
  baseIsDefault: true,
  checks: [green],
  draft: false,
  fork: false,
  headMoves: false,
  held: false,
  main: "ancestor",
  records: [pass],
  requiredChecks: ["checks"],
  stack: false,
  title: "feat: add the thing",
};

const row = (
  id: string,
  mergeSh: MergeShOutcome,
  verdict: string,
  scenario: Partial<Scenario> = {}
): Row => ({
  id,
  kind: id.startsWith("M") ? "base" : "deviation",
  mergeSh,
  scenario: { ...base, ...scenario },
  verdict,
});

export const rows: readonly Row[] = [
  row("M01", "merge", "Merge"),
  row("M02", 4, "Refuse:NoPassRecord", { records: [] }),
  row("M03", 4, "Refuse:NoPassRecord", { records: [{ ...pass, head: "old" }] }),
  row("M04", 4, "Refuse:NoPassRecord", {
    records: [{ ...pass, verdict: "changes" }],
  }),
  row("M05", "merge", "Merge", { records: [{ ...pass, source: "review" }] }),
  row("M06", "merge", "Merge", { records: [{ ...pass, source: "comment" }] }),
  row("M07", 1, "Refuse:CiNotGreen", {
    checks: [{ ...green, conclusion: "FAILURE" }],
  }),
  row("M08", 1, "Refuse:CiNotGreen", {
    checks: [
      green,
      { app: "github-actions", conclusion: "FAILURE", name: "lint" },
    ],
  }),
  ...["CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].map(
    (conclusion) =>
      row(`M09-${conclusion}`, 1, "Refuse:CiNotGreen", {
        checks: [green, { app: "github-actions", conclusion, name: "extra" }],
      })
  ),
  row("M10", "merge", "Merge", {
    checks: [
      green,
      { app: "github-actions", conclusion: "SKIPPED", name: "docs" },
      { app: "github-actions", conclusion: "NEUTRAL", name: "info" },
    ],
  }),
  row("M11", 1, "Wait:CiPending", {
    checks: [
      green,
      {
        app: "github-actions",
        conclusion: "",
        name: "slow",
        status: "in_progress",
      },
    ],
  }),
  row("M12", 4, "Refuse:NoPassRecord", {
    checks: [{ ...green, conclusion: "FAILURE" }],
    records: [],
  }),
  row("M13", 1, "Refuse:CiNotGreen", {
    checks: [{ ...green, conclusion: "FAILURE" }],
    headMoves: true,
  }),
  row("M14", 4, "Refuse:HeadMoved", { headMoves: true }),
  row("M15", 2, "Refuse:ConflictsWithMain", { main: "conflict" }),
  row("M16", 3, "Refuse:OverlapsMain", { main: "overlap" }),
  row("M17", 2, "Refuse:ConflictsWithMain", { main: "conflict" }),
  row("M18", "merge", "Merge", { main: "disjoint" }),
  row("M19", "merge", "Merge", { main: "ancestor" }),
  row("M20", 1, "Refuse:CiNotGreen", {
    checks: [
      green,
      { conclusion: undefined, name: "ci/legacy", statusContext: true },
    ],
  }),

  row("X01", "merge", "Refuse:RecordAuthor", {
    records: [{ ...pass, author: "stranger" }],
  }),
  row("X02", "merge", "Refuse:NoPassRecord", {
    records: [{ ...pass, quoted: true }],
  }),
  row("X03", "merge", "Refuse:NoPassRecord", {
    records: [
      { ...pass, round: 2 },
      { ...pass, round: 3, verdict: "changes" },
    ],
  }),
  row("X04", "merge", "Refuse:NoPassRecord", {
    records: [{ ...pass, dismissed: true }],
  }),
  row("X05", "merge", "Refuse:RequiredCheckMissing", { checks: [] }),
  row("X06", "merge", "Refuse:RequiredCheckMissing", {
    checks: [{ app: "github-actions", conclusion: "SUCCESS", name: "lint" }],
  }),
  row("X07", "merge", "Refuse:RequiredCheckMissing", {
    checks: [{ ...green, conclusion: "SKIPPED" }],
  }),
  row("X08", "merge", "Refuse:RequiredCheckMissing", {
    checks: [{ ...green, app: "other" }],
  }),
  row("X09-draft", "merge", "Refuse:PrState", { draft: true }),
  row("X09-fork", "merge", "Refuse:PrState", { fork: true }),
  row("X09-base", "merge", "Refuse:PrState", { baseIsDefault: false }),
  row("X09-title", "merge", "Refuse:PrState", { title: "add the thing" }),
  row("X10", "merge", "Refuse:Held", { held: true }),
  row("X11", "merge", "Refuse:Stacked", { stack: true }),
  row("X12", "merge", "Refuse:RecordChanged", {
    records: [{ ...pass, changed: true }],
  }),
];
