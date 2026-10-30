import type {
  CheckEntry,
  FileSet,
  MainRelation,
  PrFacts,
  RecordFact,
} from "./types.ts";

/**
 * From GitHub API responses to the facts of `decideMerge` (spec 0000, D1 "Where rules 4 and 5 get their facts at runtime").
 * The inputs are structural subsets of the documented responses (API version 2026-03-10), already decoded by the service
 * that received them. Unknown never merges: `null` and truncation map to `unknown` and `complete: false`.
 */

/** "includes up to 300 changed files for the entire comparison" (REST, Compare two commits). */
export const compareFileLimit = 300;

/** At most this many reads of a `mergeable: null` pull request before the answer is `Unknown` (about a minute). */
export const maxMergeabilityReads = 5;

export interface ApiCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly app?:
    | { readonly slug?: string | null | undefined }
    | null
    | undefined;
}

export interface ApiCommitStatus {
  readonly context: string;
  readonly state: string;
}

export const checkEntriesFromApi = (
  checkRuns: readonly ApiCheckRun[],
  statuses: readonly ApiCommitStatus[]
): readonly CheckEntry[] => [
  ...checkRuns.map((run): CheckEntry => ({
    appSlug: run.app?.slug ?? undefined,
    conclusion: run.conclusion?.toUpperCase(),
    kind: "check_run",
    name: run.name,
    status:
      run.status === "completed" || run.status === "in_progress"
        ? run.status
        : "queued",
  })),
  ...statuses.map((status): CheckEntry => ({
    appSlug: undefined,
    conclusion: undefined,
    kind: "status_context",
    name: status.context,
    status: "completed",
  })),
];

export interface ApiReview {
  readonly body?: string | null | undefined;
  readonly state: string;
  readonly submitted_at?: string | null | undefined;
  readonly user: { readonly id: number } | null;
}

export interface ApiIssueComment {
  readonly body?: string | null | undefined;
  readonly created_at: string;
  readonly user: { readonly id: number } | null;
}

/** A body that is not text, or has no author, can carry no record: it maps to an empty body from author id 0. */
export const recordsFromApi = (
  reviews: readonly ApiReview[],
  comments: readonly ApiIssueComment[],
  changedSinceFirstRead: (
    record: Omit<RecordFact, "changedSinceFirstRead">
  ) => boolean
): readonly RecordFact[] =>
  [
    ...reviews.map((review): Omit<RecordFact, "changedSinceFirstRead"> => ({
      at: review.submitted_at ?? "",
      authorId: review.user?.id ?? 0,
      body: review.body ?? "",
      dismissed: review.state === "DISMISSED",
      source: "review",
    })),
    ...comments.map((comment): Omit<RecordFact, "changedSinceFirstRead"> => ({
      at: comment.created_at,
      authorId: comment.user?.id ?? 0,
      body: comment.body ?? "",
      dismissed: false,
      source: "comment",
    })),
  ].map((record) => ({
    ...record,
    changedSinceFirstRead: changedSinceFirstRead(record),
  }));

export interface ApiCompare {
  readonly behind_by: number;
  readonly files?:
    | readonly {
        readonly filename: string;
        readonly previous_filename?: string | undefined;
      }[]
    | undefined;
}

/** File names include a rename's previous name, so the bot may refuse where `git diff --name-only` (new path only) would not. */
export const fileSetFromCompare = (compare: ApiCompare): FileSet => {
  const files = compare.files ?? [];

  return {
    complete: files.length < compareFileLimit,
    names: files.flatMap((file) =>
      file.previous_filename === undefined
        ? [file.filename]
        : [file.filename, file.previous_filename]
    ),
  };
};

/**
 * Rules 4 and 5. `ancestry` is `compare/{default}...{head}`: `behind_by == 0` means `main` is an ancestor of the head.
 * `mergeable` is the PR object's field; `null` is "GitHub is computing it". The two `since` comparisons are
 * `compare/{merge_base}...{default}` and `compare/{merge_base}...{head}`; they are only read when `main` moved.
 */
export interface MainRelationInput {
  readonly ancestry: ApiCompare;
  readonly mergeable: boolean | null;
  readonly mainSince: ApiCompare | undefined;
  readonly headSince: ApiCompare | undefined;
  readonly mergeabilityReads: number;
}

const conflictsOf = (mergeable: boolean | null): "yes" | "no" | "unknown" => {
  if (mergeable === null) {
    return "unknown";
  }

  return mergeable ? "no" : "yes";
};

export const mainRelationFromApi = (input: MainRelationInput): MainRelation => {
  if (input.ancestry.behind_by === 0) {
    return { _tag: "Ancestor" };
  }

  const empty: FileSet = { complete: false, names: [] };

  return {
    _tag: "Moved",
    conflicts: conflictsOf(input.mergeable),
    headFiles:
      input.headSince === undefined
        ? empty
        : fileSetFromCompare(input.headSince),
    mainFiles:
      input.mainSince === undefined
        ? empty
        : fileSetFromCompare(input.mainSince),
    mergeabilityExhausted:
      input.mergeable === null &&
      input.mergeabilityReads >= maxMergeabilityReads,
  };
};

export interface ApiPull {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly draft?: boolean | undefined;
  readonly merged?: boolean | undefined;
  readonly mergeable?: boolean | null | undefined;
  readonly head: {
    readonly sha: string;
    readonly repo?: { readonly full_name: string } | null | undefined;
  };
  readonly base: {
    readonly ref: string;
    readonly repo: { readonly full_name: string };
  };
  /** Present only on a PR in a native stack: the real API omits the key otherwise (spec 0000, V7). */
  readonly stack?: unknown;
}

export const prFactsFromApi = (
  pull: ApiPull,
  headRecheckSha: string,
  defaultBranch: string
): PrFacts => ({
  baseIsDefaultBranch: pull.base.ref === defaultBranch,
  draft: pull.draft ?? false,
  headRecheckSha,
  headSha: pull.head.sha,
  inStack: pull.stack !== undefined && pull.stack !== null,
  number: pull.number,
  open: pull.state === "open",
  sameRepository: pull.head.repo?.full_name === pull.base.repo.full_name,
  title: pull.title,
});
