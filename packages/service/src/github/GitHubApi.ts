import { githubApiVersion } from "@bot/rules";
import type { RepositoryConfig } from "@bot/rules";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";

import { DecodeFailure, GitHubError } from "../errors.ts";
import type { AppAuthError } from "../errors.ts";
import { guardEgress } from "./egress.ts";
import { GitHubApp } from "./GitHubApp.ts";
import type { TokenScope } from "./GitHubApp.ts";
import * as S from "./schemas.ts";

export type GitHubFailure = GitHubError | DecodeFailure | AppAuthError;

export type Pull = typeof S.PullRequest.Type;

export type PullListEntry = (typeof S.PullList.Type)[number];

export type Review = (typeof S.Reviews.Type)[number];

export type IssueComment = (typeof S.IssueComments.Type)[number];

export type CheckRun = (typeof S.CheckRuns.Type)["check_runs"][number];

export type CompareResult = typeof S.Compare.Type;

export type RunInfo = typeof S.WorkflowRun.Type;

/** How a merge request ended: `Merged` with the merge commit; `Failed` (the poll said so); `Rejected` (400: not mergeable now); `Pending` (still running when the polls ran out). */
export type MergeOutcome =
  | { readonly _tag: "Merged"; readonly sha: string }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Rejected"; readonly message: string }
  | { readonly _tag: "Pending" };

export interface MergeRequest {
  readonly number: number;
  /** The head the record names: GitHub cancels the merge when the head moved (spec 0000, F2). */
  readonly sha: string;
  readonly title: string;
}

/** Bounded polls of a merge: the 202 gives a uuid; the result is read at most this many times, a second apart. */
const mergePolls = 10;

const readScope: TokenScope = {
  actions: "read",
  checks: "read",
  contents: "read",
  issues: "read",
  metadata: "read",
  pull_requests: "read",
  statuses: "read",
};

/**
 * The only way the bot talks to a repository (spec 0000, F6). Its operations are exactly the rows of the egress table; there is
 * no operation that approves a deployment, opens a PR, or writes a file, a ref, a tag or a release. Every request carries
 * API version 2026-03-10, a token narrowed to the repository and to the least permission of the operation, and goes through the
 * egress guard. Every response is decoded with a Schema (spec 0000, D11).
 */
export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    readonly getPull: (
      repo: RepositoryConfig,
      number: number
    ) => Effect.Effect<Pull, GitHubFailure>;
    readonly listOpenPulls: (
      repo: RepositoryConfig
    ) => Effect.Effect<typeof S.PullList.Type, GitHubFailure>;
    readonly listReviews: (
      repo: RepositoryConfig,
      number: number
    ) => Effect.Effect<typeof S.Reviews.Type, GitHubFailure>;
    readonly listIssueComments: (
      repo: RepositoryConfig,
      number: number
    ) => Effect.Effect<typeof S.IssueComments.Type, GitHubFailure>;
    readonly listPullFiles: (
      repo: RepositoryConfig,
      number: number
    ) => Effect.Effect<typeof S.PullFiles.Type, GitHubFailure>;
    readonly listCheckRuns: (
      repo: RepositoryConfig,
      sha: string
    ) => Effect.Effect<typeof S.CheckRuns.Type, GitHubFailure>;
    readonly getCombinedStatus: (
      repo: RepositoryConfig,
      sha: string
    ) => Effect.Effect<typeof S.CombinedStatus.Type, GitHubFailure>;
    readonly compare: (
      repo: RepositoryConfig,
      base: string,
      head: string
    ) => Effect.Effect<CompareResult, GitHubFailure>;
    /** The git blob sha of a file at a ref, `undefined` when the file does not exist (404). */
    readonly blobSha: (
      repo: RepositoryConfig,
      path: string,
      ref: string
    ) => Effect.Effect<string | undefined, GitHubFailure>;
    /** The text of a file at a ref, `undefined` when it does not exist. */
    readonly fileText: (
      repo: RepositoryConfig,
      path: string,
      ref: string
    ) => Effect.Effect<string | undefined, GitHubFailure>;
    readonly branchHead: (
      repo: RepositoryConfig,
      branch: string
    ) => Effect.Effect<string, GitHubFailure>;
    readonly merge: (
      repo: RepositoryConfig,
      request: MergeRequest
    ) => Effect.Effect<MergeOutcome, GitHubFailure>;
    readonly dispatch: (
      repo: RepositoryConfig,
      input: {
        readonly workflow: string;
        readonly ref: "main";
        readonly inputs: Readonly<Record<string, string>>;
      }
    ) => Effect.Effect<typeof S.DispatchResponse.Type, GitHubFailure>;
    readonly listRuns: (
      repo: RepositoryConfig,
      input: { readonly workflow: string; readonly headSha: string }
    ) => Effect.Effect<readonly RunInfo[], GitHubFailure>;
    readonly getRun: (
      repo: RepositoryConfig,
      runId: number
    ) => Effect.Effect<RunInfo, GitHubFailure>;
    readonly createComment: (
      repo: RepositoryConfig,
      number: number,
      body: string
    ) => Effect.Effect<number, GitHubFailure>;
  }
>()("bot/github/GitHubApi") {
  static readonly layer = Layer.effect(
    GitHubApi,
    Effect.gen(function* () {
      const app = yield* GitHubApp;
      const http = guardEgress(yield* HttpClient.HttpClient);

      const retryAfter = (
        response: HttpClientResponse.HttpClientResponse
      ): number | undefined => {
        const header = response.headers["retry-after"];

        if (header !== undefined) {
          return Number(header);
        }

        return response.headers["x-ratelimit-remaining"] === "0"
          ? 60
          : undefined;
      };

      /** One request with a token narrowed to `scope` on `repo`; the caller says which statuses it accepts. */
      const send = Effect.fn("GitHubApi.send")(function* (
        repo: RepositoryConfig,
        scope: TokenScope,
        operation: string,
        request: HttpClientRequest.HttpClientRequest,
        accepted: readonly number[]
      ) {
        const token = yield* app.token({
          account: repo.account,
          permissions: scope,
          repository: repo.fullName,
        });

        const response = yield* http
          .execute(
            request.pipe(
              HttpClientRequest.bearerToken(Redacted.value(token)),
              HttpClientRequest.setHeaders({
                accept: "application/vnd.github+json",
                "user-agent": "phibkro-release-bot",
                "x-github-api-version": githubApiVersion,
              })
            )
          )
          .pipe(
            Effect.mapError(
              (cause) => new GitHubError({ message: String(cause), operation })
            )
          );

        if (!accepted.includes(response.status)) {
          const wait =
            response.status === 403 || response.status === 429
              ? retryAfter(response)
              : undefined;

          return yield* new GitHubError({
            message: `status ${response.status}`,
            operation,
            status: response.status,
            ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
          });
        }

        return response;
      });

      const decode = <A>(
        operation: string,
        schema: Schema.Decoder<A>,
        response: HttpClientResponse.HttpClientResponse
      ): Effect.Effect<A, DecodeFailure> =>
        response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(schema)),
          Effect.mapError(
            (cause) => new DecodeFailure({ message: String(cause), operation })
          )
        );

      const base = (repo: RepositoryConfig) =>
        `https://api.github.com/repos/${repo.fullName}`;

      const read = <A>(
        operation: string,
        schema: Schema.Decoder<A>,
        repo: RepositoryConfig,
        pathAndQuery: string,
        urlParams: Readonly<Record<string, string>> = {}
      ): Effect.Effect<A, GitHubFailure> =>
        send(
          repo,
          readScope,
          operation,
          HttpClientRequest.get(`${base(repo)}${pathAndQuery}`).pipe(
            HttpClientRequest.setUrlParams(urlParams)
          ),
          [200]
        ).pipe(
          Effect.flatMap((response) => decode(operation, schema, response))
        );

      const content = Effect.fn("GitHubApi.content")(function* (
        repo: RepositoryConfig,
        path: string,
        ref: string
      ) {
        const request = HttpClientRequest.get(
          `${base(repo)}/contents/${path}`
        ).pipe(HttpClientRequest.setUrlParams({ ref }));

        const response = yield* send(
          repo,
          readScope,
          "getContent",
          request,
          [200, 404]
        );

        return response.status === 404
          ? undefined
          : yield* decode("getContent", S.ContentFile, response);
      });

      const pollMerge = Effect.fn("GitHubApi.pollMerge")(function* (
        repo: RepositoryConfig,
        number: number,
        uuid: string
      ) {
        for (let attempt = 0; attempt < mergePolls; attempt += 1) {
          const response = yield* send(
            repo,
            { contents: "write", metadata: "read" },
            "pollMerge",
            HttpClientRequest.get(
              `${base(repo)}/pulls/${number}/merge-async/${uuid}`
            ),
            [200]
          );

          const result = yield* decode(
            "pollMerge",
            S.MergeAsyncResult,
            response
          );

          if (result.status === "merged" && result.details?.sha !== undefined) {
            return { _tag: "Merged", sha: result.details.sha } as const;
          }

          if (result.status === "failed" || result.status === "enqueued") {
            return {
              _tag: "Failed",
              message: result.details?.message ?? result.status,
            } as const;
          }

          yield* Effect.sleep("1 second");
        }

        return { _tag: "Pending" } as const;
      });

      const merge = Effect.fn("GitHubApi.merge")(function* (
        repo: RepositoryConfig,
        request: MergeRequest
      ) {
        const response = yield* send(
          repo,
          { contents: "write", metadata: "read" },
          "mergeAsync",
          HttpClientRequest.put(
            `${base(repo)}/pulls/${request.number}/merge-async`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              bypass_rules: false,
              commit_title: `${request.title} (#${request.number})`,
              merge_action: "direct_merge",
              merge_method: "squash",
              sha: request.sha,
            })
          ),
          [200, 202, 400, 409]
        );

        const result = yield* decode(
          "mergeAsync",
          S.MergeAsyncResult,
          response
        );

        if (response.status === 400) {
          return {
            _tag: "Rejected",
            message: result.details?.message ?? "not ready to be merged",
          } as const;
        }

        if (result.status === "merged" && result.details?.sha !== undefined) {
          return { _tag: "Merged", sha: result.details.sha } as const;
        }

        const uuid = result.details?.uuid;

        return uuid === undefined
          ? ({ _tag: "Pending" } as const)
          : yield* pollMerge(repo, request.number, uuid);
      });

      const dispatch = Effect.fn("GitHubApi.dispatch")(function* (
        repo: RepositoryConfig,
        input: {
          readonly workflow: string;
          readonly ref: "main";
          readonly inputs: Readonly<Record<string, string>>;
        }
      ) {
        // API 2026-03-10: always 200 with the run's id and URLs. Anything else is a failed call, never a success (spec 0000, D6).
        const response = yield* send(
          repo,
          { actions: "write", metadata: "read" },
          "dispatchWorkflow",
          HttpClientRequest.post(
            `${base(repo)}/actions/workflows/${input.workflow}/dispatches`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              inputs: input.inputs,
              ref: input.ref,
            })
          ),
          [200]
        );

        return yield* decode("dispatchWorkflow", S.DispatchResponse, response);
      });

      const createComment = Effect.fn("GitHubApi.createComment")(function* (
        repo: RepositoryConfig,
        number: number,
        body: string
      ) {
        const response = yield* send(
          repo,
          { issues: "write", metadata: "read" },
          "createComment",
          HttpClientRequest.post(
            `${base(repo)}/issues/${number}/comments`
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ body })),
          [201]
        );

        return (yield* decode("createComment", S.CreatedComment, response)).id;
      });

      return GitHubApi.of({
        blobSha: (repo, path, ref) =>
          content(repo, path, ref).pipe(Effect.map((file) => file?.sha)),
        branchHead: (repo, branch) =>
          read("getCommit", S.CommitRef, repo, `/commits/${branch}`).pipe(
            Effect.map((commit) => commit.sha)
          ),
        compare: (repo, baseRef, head) =>
          read("compare", S.Compare, repo, `/compare/${baseRef}...${head}`),
        createComment,
        dispatch,
        fileText: (repo, path, ref) =>
          content(repo, path, ref).pipe(
            Effect.map((file) =>
              file?.content === undefined
                ? undefined
                : atob(file.content.replaceAll("\n", ""))
            )
          ),
        getCombinedStatus: (repo, sha) =>
          read(
            "getCombinedStatus",
            S.CombinedStatus,
            repo,
            `/commits/${sha}/status`
          ),
        getPull: (repo, number) =>
          read("getPull", S.PullRequest, repo, `/pulls/${number}`),
        getRun: (repo, runId) =>
          read("getRun", S.WorkflowRun, repo, `/actions/runs/${runId}`),
        listCheckRuns: (repo, sha) =>
          read(
            "listCheckRuns",
            S.CheckRuns,
            repo,
            `/commits/${sha}/check-runs`,
            { per_page: "100" }
          ),
        listIssueComments: (repo, number) =>
          read(
            "listIssueComments",
            S.IssueComments,
            repo,
            `/issues/${number}/comments`,
            { per_page: "100" }
          ),
        listOpenPulls: (repo) =>
          read("listPulls", S.PullList, repo, "/pulls", {
            per_page: "100",
            state: "open",
          }),
        listPullFiles: (repo, number) =>
          read("listPullFiles", S.PullFiles, repo, `/pulls/${number}/files`, {
            per_page: "100",
          }),
        listReviews: (repo, number) =>
          read("listReviews", S.Reviews, repo, `/pulls/${number}/reviews`, {
            per_page: "100",
          }),
        listRuns: (repo, input) =>
          read(
            "listWorkflowRuns",
            S.WorkflowRuns,
            repo,
            `/actions/workflows/${input.workflow}/runs`,
            {
              event: "workflow_dispatch",
              head_sha: input.headSha,
            }
          ).pipe(Effect.map((runs) => runs.workflow_runs)),
        merge,
      });
    })
  );
}
