import { findRepository } from "@bot/rules";
import type { RepositoryConfig } from "@bot/rules";
import { Effect, Layer } from "effect";

import { GitHubApi } from "../src/index.ts";
import type {
  CompareResult,
  GitHubFailure,
  IssueComment,
  MergeOutcome,
  Pull,
  Review,
  RunInfo,
} from "../src/index.ts";

/**
 * An in-memory GitHub for the journey tests: the `GitHubApi` service over a mutable world. Every operation is logged by name, and
 * every write by its arguments, so a test can assert exactly what the bot did (F4, F6, F11, F14). It is not a mock of the rules:
 * `decideMerge` and `decideDispatch` run for real on the facts it serves.
 */

export const operatorId = 71_797_726;
export const strangerId = 99;

export interface WorldPull {
  number: number;
  title: string;
  open: boolean;
  merged: boolean;
  draft: boolean;
  headSha: string;
  baseRef: string;
  mergeable: boolean | null;
  mergeCommitSha: string | undefined;
  stack: unknown;
  reviews: { body: string; authorId: number; state: string; at: string }[];
  comments: { id: number; body: string; authorId: number; at: string }[];
  files: { filename: string; status: string }[];
}

/** A simulated eviction: an effect that dies, set for one test and cleared before the retry. */
export type Hook = (() => Effect.Effect<void>) | undefined;

/** Run a write between its two eviction points: `before` when the call arrives, `after` once it took effect. */
const around = <A, E>(
  before: Hook,
  after: Hook,
  run: () => Effect.Effect<A, E>
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    if (before !== undefined) {
      yield* before();
    }

    const result = yield* run();

    if (after !== undefined) {
      yield* after();
    }

    return result;
  });

export interface World {
  pulls: Map<number, WorldPull>;
  checks: Map<
    string,
    {
      name: string;
      status: string;
      conclusion: string | null;
      app: string;
    }[]
  >;
  mainHead: string;
  nextMerge: string;
  blobs: Map<string, string>;
  texts: Map<string, string>;
  runs: Map<number, RunInfo>;
  calls: string[];
  writes: { op: string; detail: unknown }[];
  nextCommentId: number;
  nextRunId: number;
  /** When set, `merge-async` answers 400 with this message, and nothing merges. */
  mergeRefusal: string | undefined;
  /**
   * Hooks that simulate an eviction at the two points of F14, for each action kind: `before*` runs when the call arrives, before
   * it takes effect (the intent row exists, the write does not); `after*` runs once it took effect, before its answer returns
   * (the write exists, the receipt does not).
   */
  beforeMerge: Hook;
  afterMerge: Hook;
  beforeDispatch: Hook;
  afterDispatch: Hook;
  beforeComment: Hook;
  afterComment: Hook;
  now: () => string;
}

export const sha = (letter: string): string => letter.repeat(40);

export const passBody = (head: string, round = 1, verdict = "pass"): string =>
  `<!-- review-round n=${round} head=${head} verdict=${verdict} -->\n## Review round ${round}\n`;

export const makeWorld = (cfg: RepositoryConfig): World => {
  const blobs = new Map<string, string>([
    [".agents/skills/review-pr/merge.sh", cfg.pins.mergeSh],
    [".agents/skills/review-pr/record-round.sh", cfg.pins.recordRound],
  ]);

  if (cfg.pins.checkRecord !== undefined) {
    blobs.set(".agents/skills/review-pr/check-record.sh", cfg.pins.checkRecord);
  }

  return {
    afterComment: undefined,
    afterDispatch: undefined,
    afterMerge: undefined,
    beforeComment: undefined,
    beforeDispatch: undefined,
    beforeMerge: undefined,
    blobs,
    calls: [],
    checks: new Map(),
    mainHead: sha("0"),
    mergeRefusal: undefined,
    nextCommentId: 1,
    nextMerge: sha("e"),
    nextRunId: 100,
    now: () => "2026-10-30T12:00:00Z",
    pulls: new Map(),
    runs: new Map(),
    texts: new Map(),
    writes: [],
  };
};

export const addPull = (
  world: World,
  pull: Partial<WorldPull> & { number: number }
): WorldPull => {
  const full: WorldPull = {
    baseRef: "main",
    comments: [],
    draft: false,
    files: [],
    headSha: sha("a"),
    mergeCommitSha: undefined,
    mergeable: true,
    merged: false,
    open: true,
    reviews: [
      {
        at: "2026-10-30T11:00:00Z",
        authorId: operatorId,
        body: passBody(pull.headSha ?? sha("a")),
        state: "COMMENTED",
      },
    ],
    stack: undefined,
    title: "feat: add the thing",
    ...pull,
  };

  world.pulls.set(full.number, full);
  world.checks.set(full.headSha, [
    {
      app: "github-actions",
      conclusion: "success",
      name: "checks",
      status: "completed",
    },
  ]);

  return full;
};

const pullOf = (pull: WorldPull, repo: RepositoryConfig): Pull => ({
  base: { ref: pull.baseRef, repo: { full_name: repo.fullName } },
  draft: pull.draft,
  head: { repo: { full_name: repo.fullName }, sha: pull.headSha },
  merge_commit_sha: pull.mergeCommitSha ?? null,
  mergeable: pull.mergeable,
  merged: pull.merged,
  number: pull.number,
  ...(pull.stack === undefined ? {} : { stack: pull.stack }),
  state: pull.open ? "open" : "closed",
  title: pull.title,
});

const need = (world: World, number: number): WorldPull => {
  const pull = world.pulls.get(number);

  if (pull === undefined) {
    throw new Error(`fake GitHub: no PR ${number}`);
  }

  return pull;
};

export const fakeGitHub = (world: World) =>
  Layer.succeed(
    GitHubApi,
    GitHubApi.of({
      blobSha: (_repo, path) => {
        world.calls.push("getContent");

        return Effect.succeed(world.blobs.get(path));
      },
      branchHead: () => {
        world.calls.push("getCommit");

        return Effect.succeed(world.mainHead);
      },
      compare: (
        _repo,
        base,
        head
      ): Effect.Effect<CompareResult, GitHubFailure> => {
        world.calls.push("compare");

        return Effect.succeed({
          behind_by: 0,
          files: [],
          merge_base_commit: { sha: base === head ? base : base },
        });
      },
      createComment: (_repo, number, body) =>
        around(world.beforeComment, world.afterComment, () => {
          world.calls.push("createComment");
          const pull = need(world, number);
          const id = world.nextCommentId;
          world.nextCommentId += 1;
          pull.comments.push({ at: world.now(), authorId: 1, body, id });
          world.writes.push({ detail: { body, number }, op: "createComment" });

          return Effect.succeed(id);
        }),
      dispatch: (_repo, input) =>
        around(world.beforeDispatch, world.afterDispatch, () => {
          world.calls.push("dispatchWorkflow");
          const runId = world.nextRunId;
          world.nextRunId += 1;

          const run: RunInfo = {
            conclusion: null,
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: world.mainHead,
            html_url: `https://github.com/phibkro/pg-txmode/actions/runs/${runId}`,
            id: runId,
            status: "queued",
          };

          world.runs.set(runId, run);
          world.writes.push({ detail: input, op: "dispatchWorkflow" });

          return Effect.succeed({
            html_url: run.html_url,
            run_url: `https://api.github.com/runs/${runId}`,
            workflow_run_id: runId,
          });
        }),
      fileText: (_repo, path, ref) => {
        world.calls.push("getContent");

        return Effect.succeed(world.texts.get(`${path}@${ref}`));
      },
      getCombinedStatus: () => {
        world.calls.push("getCombinedStatus");

        return Effect.succeed({ statuses: [] });
      },
      getPull: (repo, number) => {
        world.calls.push("getPull");

        return Effect.succeed(pullOf(need(world, number), repo));
      },
      getRun: (_repo, runId) => {
        world.calls.push("getRun");
        const run = world.runs.get(runId);

        return run === undefined
          ? Effect.die(new Error(`fake GitHub: no run ${runId}`))
          : Effect.succeed(run);
      },
      listCheckRuns: (_repo, headSha) => {
        world.calls.push("listCheckRuns");

        const runs = (world.checks.get(headSha) ?? []).map((run) => ({
          app: { slug: run.app },
          conclusion: run.conclusion,
          name: run.name,
          status: run.status,
        }));

        return Effect.succeed({ check_runs: runs, total_count: runs.length });
      },
      listIssueComments: (_repo, number) => {
        world.calls.push("listIssueComments");
        const pull = need(world, number);

        const comments: readonly IssueComment[] = pull.comments.map(
          (comment) => ({
            body: comment.body,
            created_at: comment.at,
            id: comment.id,
            user: { id: comment.authorId },
          })
        );

        return Effect.succeed(comments);
      },
      listOpenPulls: () => {
        world.calls.push("listPulls");

        return Effect.succeed(
          [...world.pulls.values()].flatMap((pull) =>
            pull.open
              ? [
                  {
                    head: { sha: pull.headSha },
                    number: pull.number,
                    state: "open",
                    title: pull.title,
                  },
                ]
              : []
          )
        );
      },
      listPullFiles: (_repo, number) => {
        world.calls.push("listPullFiles");

        return Effect.succeed(need(world, number).files);
      },
      listReviews: (_repo, number) => {
        world.calls.push("listReviews");

        const reviews: readonly Review[] = need(world, number).reviews.map(
          (review) => ({
            body: review.body,
            state: review.state,
            submitted_at: review.at,
            user: { id: review.authorId },
          })
        );

        return Effect.succeed(reviews);
      },
      listRuns: (_repo, input) => {
        world.calls.push("listWorkflowRuns");

        return Effect.succeed(
          [...world.runs.values()].filter(
            (run) => run.head_sha === input.headSha
          )
        );
      },
      merge: (repo, request): Effect.Effect<MergeOutcome, GitHubFailure> =>
        around(world.beforeMerge, world.afterMerge, () => {
          world.calls.push("mergeAsync");
          const pull = need(world, request.number);
          world.writes.push({
            detail: {
              number: request.number,
              sha: request.sha,
              title: request.title,
            },
            op: "mergeAsync",
          });

          if (world.mergeRefusal !== undefined) {
            return Effect.succeed<MergeOutcome>({
              _tag: "Rejected",
              message: world.mergeRefusal,
            });
          }

          if (pull.headSha !== request.sha || !pull.open) {
            return Effect.succeed<MergeOutcome>({
              _tag: "Failed",
              message: "head did not match",
            });
          }

          pull.merged = true;
          pull.open = false;
          pull.mergeCommitSha = world.nextMerge;
          world.mainHead = world.nextMerge;
          void repo;

          return Effect.succeed<MergeOutcome>({
            _tag: "Merged",
            sha: world.nextMerge,
          });
        }),
    })
  );

export const configOf = (
  name: string,
  mode: "observe" | "act"
): RepositoryConfig => {
  const found = findRepository(name);

  if (found === undefined) {
    throw new Error(`no repository ${name}`);
  }

  return { ...found, mode };
};

export const writesOf = (world: World, op: string) =>
  world.writes.filter((write) => write.op === op);
