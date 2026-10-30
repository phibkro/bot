import { appPermissions, findRepository, levelAtLeast } from "@bot/rules";
import type { RepositoryConfig } from "@bot/rules";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import {
  declaredOperations,
  GitHubApi,
  guardEgress,
  matchOperation,
} from "../src/index.ts";
import checkRuns from "./fixtures/github/check-runs.json" with { type: "json" };
import compareAhead from "./fixtures/github/compare-ahead.json" with { type: "json" };
import compareBehind from "./fixtures/github/compare-behind.json" with { type: "json" };
import contents from "./fixtures/github/contents-merge-sh.json" with { type: "json" };
import pullMerged from "./fixtures/github/pull-merged.json" with { type: "json" };
import pullsList from "./fixtures/github/pulls-list.json" with { type: "json" };
import reviews from "./fixtures/github/reviews-record.json" with { type: "json" };
import status from "./fixtures/github/status.json" with { type: "json" };
import { fakeApp, fakeHttp, testToken } from "./httpFake.ts";
import type { FakeReply, RecordedRequest } from "./httpFake.ts";

/**
 * The real `GitHubApi` over a fake HTTP client. The fixtures were captured from the real API (`tools/capture/capture.sh`), so the
 * schemas decode real shapes (F20, spec 0000): notably a pull request that is not stacked has no `stack` key at all.
 */

const repo: RepositoryConfig = (() => {
  const found = findRepository("phibkro/pg-txmode");

  if (found === undefined) {
    throw new Error("repository missing from the declaration");
  }

  return found;
})();

const run = <A, E>(
  answer: (request: RecordedRequest) => FakeReply,
  program: Effect.Effect<A, E, GitHubApi>
) => {
  const http = fakeHttp(answer);

  const layer = GitHubApi.layer.pipe(
    Layer.provide(fakeApp),
    Layer.provide(http.layer)
  );

  return {
    requests: http.requests,
    result: program.pipe(Effect.provide(layer)),
  };
};

describe("GitHubApi decodes the captured real responses", () => {
  it.effect(
    "pull, reviews, compare, check runs, statuses, contents and the pull list",
    () => {
      const { result } = run(
        (request) => {
          const path = new URL(request.url).pathname;

          if (path.endsWith("/pulls/18")) {
            return { body: pullMerged, status: 200 };
          }

          if (path.endsWith("/pulls/1/reviews")) {
            return { body: reviews, status: 200 };
          }

          if (path.includes("/compare/") && request.url.includes("...")) {
            return {
              body: request.url.includes("main...")
                ? compareBehind
                : compareAhead,
              status: 200,
            };
          }

          if (path.endsWith("/check-runs")) {
            return { body: checkRuns, status: 200 };
          }

          if (path.endsWith("/status")) {
            return { body: status, status: 200 };
          }

          if (path.includes("/contents/")) {
            return { body: contents, status: 200 };
          }

          return { body: pullsList, status: 200 };
        },
        Effect.gen(function* () {
          const api = yield* GitHubApi;
          const pull = yield* api.getPull(repo, 18);
          assert.strictEqual(pull.merged, true);
          assert.strictEqual(pull.stack, undefined);
          assert.isFalse("stack" in pull);
          const list = yield* api.listReviews(repo, 1);
          assert.isAbove(list.length, 0);

          const ahead = yield* api.compare(
            repo,
            "a".repeat(40),
            "b".repeat(40)
          );

          assert.isNumber(ahead.behind_by);
          const runs = yield* api.listCheckRuns(repo, "c".repeat(40));
          assert.isTrue(
            runs.check_runs.some(
              (entry) =>
                entry.name === "checks" && entry.app?.slug === "github-actions"
            )
          );
          assert.deepStrictEqual(
            (yield* api.getCombinedStatus(repo, "c".repeat(40))).statuses,
            []
          );
          assert.strictEqual(
            yield* api.blobSha(
              repo,
              ".agents/skills/review-pr/merge.sh",
              "main"
            ),
            repo.pins.mergeSh
          );
          assert.isAbove((yield* api.listOpenPulls(repo)).length, 0);
        })
      );

      return result;
    }
  );

  it.effect(
    "a pull request in a native stack decodes with its stack object",
    () => {
      const { result } = run(
        () => ({
          body: { ...pullMerged, stack: { position: 2, size: 3 } },
          status: 200,
        }),
        GitHubApi.use((api) => api.getPull(repo, 18)).pipe(
          Effect.map((pull) => {
            assert.isDefined(pull.stack);
          })
        )
      );

      return result;
    }
  );

  it.effect(
    "a response of the wrong shape is a DecodeFailure, never a trusted value",
    () => {
      const { result } = run(
        () => ({ body: { number: "eighteen" }, status: 200 }),
        GitHubApi.use((api) => api.getPull(repo, 18)).pipe(Effect.flip)
      );

      return result.pipe(
        Effect.map((error) => {
          assert.strictEqual(error._tag, "DecodeFailure");
        })
      );
    }
  );
});

describe("GitHubApi requests (F2, F6, D6, D7)", () => {
  it.effect(
    "every request carries API 2026-03-10, a bearer token, and is a declared operation",
    () => {
      const { requests, result } = run(
        () => ({ body: pullMerged, status: 200 }),
        GitHubApi.use((api) => api.getPull(repo, 18))
      );

      return result.pipe(
        Effect.map(() => {
          for (const request of requests) {
            assert.strictEqual(
              request.headers["x-github-api-version"],
              "2026-03-10"
            );
            assert.strictEqual(
              request.headers.authorization,
              `Bearer ${testToken}`
            );
            assert.isDefined(matchOperation(request.method, request.url));
          }
        })
      );
    }
  );

  it.effect(
    "the merge request carries the reviewed sha, squash, direct merge and never bypass_rules",
    () => {
      const { requests, result } = run(
        (request) =>
          request.method === "PUT"
            ? {
                body: { details: { sha: "d".repeat(40) }, status: "merged" },
                status: 200,
              }
            : { status: 404 },
        GitHubApi.use((api) =>
          api.merge(repo, { number: 7, sha: "a".repeat(40), title: "feat: x" })
        )
      );

      return result.pipe(
        Effect.map((outcome) => {
          assert.deepStrictEqual(outcome, {
            _tag: "Merged",
            sha: "d".repeat(40),
          });
          const [request] = requests;
          assert.strictEqual(request?.method, "PUT");
          assert.include(request?.url ?? "", "/pulls/7/merge-async");
          const body = request?.body ?? "";
          assert.include(body, `"sha":"${"a".repeat(40)}"`);
          assert.include(body, '"merge_method":"squash"');
          assert.include(body, '"merge_action":"direct_merge"');
          assert.include(body, '"bypass_rules":false');
          assert.include(body, '"commit_title":"feat: x (#7)"');
        })
      );
    }
  );

  it.live(
    "a 202 is polled by its uuid until the merge is done; a failed poll is Failed; a 400 is Rejected",
    () => {
      let polls = 0;

      const accepted = run(
        (request) => {
          if (request.method === "PUT") {
            return {
              body: { details: { uuid: "u-1" }, status: "pending" },
              status: 202,
            };
          }

          polls += 1;

          return polls < 2
            ? {
                body: { details: { uuid: "u-1" }, status: "pending" },
                status: 200,
              }
            : {
                body: { details: { sha: "d".repeat(40) }, status: "merged" },
                status: 200,
              };
        },
        GitHubApi.use((api) =>
          api.merge(repo, { number: 7, sha: "a".repeat(40), title: "feat: x" })
        )
      );

      const rejected = run(
        () => ({
          body: { details: { message: "closed" }, status: "failed" },
          status: 400,
        }),
        GitHubApi.use((api) =>
          api.merge(repo, { number: 7, sha: "a".repeat(40), title: "feat: x" })
        )
      );

      return Effect.gen(function* () {
        // The poll waits a second between reads, on the live clock of this test.
        assert.deepStrictEqual(
          yield* accepted.result.pipe(Effect.timeout("10 seconds")),
          { _tag: "Merged", sha: "d".repeat(40) }
        );
        assert.strictEqual((yield* rejected.result)._tag, "Rejected");
        assert.strictEqual(
          accepted.requests[0]?.url.includes("/merge-async/"),
          false
        );
        assert.isTrue(
          accepted.requests
            .slice(1)
            .every((request) => request.url.includes("/merge-async/u-1"))
        );
      });
    }
  );

  it.live(
    "D6: the dispatch answers 200 with the run id; a 204 is a failed call, never a success",
    () => {
      const ok = run(
        () => ({
          body: {
            html_url: "https://github.com/phibkro/pg-txmode/actions/runs/9",
            run_url: "https://api.github.com/x",
            workflow_run_id: 9,
          },
          status: 200,
        }),
        GitHubApi.use((api) =>
          api.dispatch(repo, {
            inputs: { mode: "publish" },
            ref: "main",
            workflow: "release.yml",
          })
        )
      );

      const noContent = run(
        () => ({ status: 204 }),
        GitHubApi.use((api) =>
          api.dispatch(repo, {
            inputs: { mode: "publish" },
            ref: "main",
            workflow: "release.yml",
          })
        ).pipe(Effect.flip)
      );

      return Effect.gen(function* () {
        const response = yield* ok.result;
        assert.strictEqual(response.workflow_run_id, 9);
        const [request] = ok.requests;
        assert.include(
          request?.url ?? "",
          "/actions/workflows/release.yml/dispatches"
        );
        assert.strictEqual(
          request?.body,
          '{"inputs":{"mode":"publish"},"ref":"main"}'
        );
        const failure = yield* noContent.result;
        assert.strictEqual(failure._tag, "GitHubError");
      });
    }
  );

  it.effect(
    "a rate limit carries its retry-after, and no token ever appears in an error",
    () => {
      const { result } = run(
        () => ({ headers: { "retry-after": "30" }, status: 403 }),
        GitHubApi.use((api) => api.getPull(repo, 18)).pipe(Effect.flip)
      );

      return result.pipe(
        Effect.map((error) => {
          assert.strictEqual(error._tag, "GitHubError");
          assert.strictEqual(
            error._tag === "GitHubError" ? error.retryAfterSeconds : undefined,
            30
          );
          assert.notInclude(String(error), testToken);
        })
      );
    }
  );
});

describe("F6: the egress table", () => {
  const denied = [
    {
      method: "POST",
      url: "https://api.github.com/repos/phibkro/pg-txmode/actions/runs/1/pending_deployments",
    },
    {
      method: "POST",
      url: "https://api.github.com/repos/phibkro/pg-txmode/actions/runs/1/deployment_protection_rule",
    },
    {
      method: "POST",
      url: "https://api.github.com/repos/phibkro/pg-txmode/pulls",
    },
    {
      method: "PUT",
      url: "https://api.github.com/repos/phibkro/pg-txmode/contents/README.md",
    },
    {
      method: "POST",
      url: "https://api.github.com/repos/phibkro/pg-txmode/git/refs",
    },
    {
      method: "POST",
      url: "https://api.github.com/repos/phibkro/pg-txmode/releases",
    },
    {
      method: "POST",
      url: "https://api.github.com/repos/phibkro/pg-txmode/pulls/1/reviews",
    },
    {
      method: "GET",
      url: "https://evil.example/repos/phibkro/pg-txmode/pulls/1",
    },
    {
      method: "GET",
      url: "http://api.github.com/repos/phibkro/pg-txmode/pulls/1",
    },
  ] as const;

  it.effect.each(denied)(
    "$method $url is refused before it leaves",
    ({ method, url }) => {
      const http = fakeHttp(() => ({ status: 200 }));

      return Effect.gen(function* () {
        const guarded = guardEgress(yield* HttpClient.HttpClient);

        const error = yield* guarded
          .execute(HttpClientRequest.make(method)(url))
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "EgressDenied");
        assert.strictEqual(http.requests.length, 0);
      }).pipe(Effect.provide(http.layer));
    }
  );

  it("every declared operation needs a permission that the App is granted, and the App holds no forbidden one", () => {
    for (const operation of declaredOperations) {
      if (operation.permission === "app") {
        continue;
      }

      const granted = appPermissions[operation.permission.name];
      assert.isTrue(
        levelAtLeast(granted.level, operation.permission.level),
        `${operation.name} needs ${operation.permission.name}:${operation.permission.level}`
      );
    }

    const never = [
      "deployments",
      "environments",
      "workflows",
      "administration",
    ];

    for (const name of never) {
      assert.isFalse(name in appPermissions);
    }

    assert.strictEqual(appPermissions.pull_requests.level, "read");
  });

  it("no declared operation can approve a deployment, open a PR or write a file, a ref or a release", () => {
    for (const operation of declaredOperations) {
      assert.notMatch(
        operation.pattern.source,
        /pending_deployments|deployment_protection_rule|git|releases/u
      );

      if (operation.method !== "GET") {
        assert.include(
          [
            "mergeAsync",
            "dispatchWorkflow",
            "createComment",
            "createInstallationToken",
          ],
          operation.name
        );
      }
    }
  });
});
