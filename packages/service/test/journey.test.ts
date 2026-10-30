import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { declaredOperations, Bot, ReleaseLedger } from "../src/index.ts";
import type { Hint } from "../src/index.ts";
import {
  addPull,
  configOf,
  makeWorld,
  operatorId,
  passBody,
  sha,
  strangerId,
  writesOf,
} from "./fakeGitHub.ts";
import type { World } from "./fakeGitHub.ts";
import { botStack } from "./support.ts";

/**
 * The journeys of spec 0000 on the real `Bot`, ledger (SQLite) and pure rules, over a fake GitHub and a fake registry whose
 * documents were captured from the live one. They assert what the bot did (the writes), never what the rules decided in
 * isolation: F1 to F4, F7 to F9, F11, F14, F16, F17.
 */

const repoName = "phibkro/pg-txmode";
const actCfg = configOf(repoName, "act");
const observeCfg = configOf(repoName, "observe");

const pullHint = (number: number): Hint => ({
  _tag: "Pull",
  number,
  repository: repoName,
});

const runHint = (runId: number): Hint => ({
  _tag: "Run",
  repository: repoName,
  runId,
});

const deliver = (id: string, hint: Hint, event = "pull_request_review") =>
  Bot.use((bot) =>
    bot.deliver({ action: "submitted", deliveryId: id, event, hint })
  );

const alarm = Bot.use((bot) => bot.alarm);

const allowedOps = new Set(
  declaredOperations.map((operation) => operation.name)
);

const assertDeclaredOnly = (world: World) => {
  for (const call of world.calls) {
    assert.isTrue(
      allowedOps.has(call),
      `operation ${call} is not in the egress table`
    );
  }
};

const versionPr = (
  world: World,
  number: number,
  head: string,
  merged: string | undefined
) =>
  addPull(world, {
    headSha: head,
    mergeCommitSha: merged,
    merged: merged !== undefined,
    number,
    open: merged === undefined,
    reviews: [
      {
        at: "2026-10-30T11:00:00Z",
        authorId: operatorId,
        body: passBody(head),
        state: "COMMENTED",
      },
    ],
    title: "chore(release): version packages 0.1.0-alpha.3",
  });

describe("merge journeys", () => {
  it.effect(
    "F11: in observe mode the bot decides and audits and writes nothing",
    () => {
      const world = makeWorld(observeCfg);
      addPull(world, { number: 7 });

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.deepStrictEqual(world.writes, []);
        const audit = yield* ReleaseLedger.use((ledger) => ledger.auditEntries);
        const verdict = audit.find((entry) => entry.kind === "merge-verdict");
        assert.isDefined(verdict);
        assert.include(verdict?.detail ?? "", '"_tag":"Merge"');
        assertDeclaredOnly(world);
      }).pipe(Effect.provide(botStack(world, [observeCfg])));
    }
  );

  it.effect(
    "F2 and F4: act mode merges the reviewed head once, however often it is told",
    () => {
      const world = makeWorld(actCfg);
      const pull = addPull(world, { number: 7 });

      return Effect.gen(function* () {
        assert.strictEqual(yield* deliver("d1", pullHint(7)), "admitted");
        assert.strictEqual(yield* deliver("d1", pullHint(7)), "duplicate");
        assert.strictEqual(
          yield* deliver("d2", pullHint(7), "check_run"),
          "admitted"
        );
        yield* alarm;
        yield* deliver("d3", pullHint(7));
        yield* alarm;
        const merges = writesOf(world, "mergeAsync");
        assert.strictEqual(merges.length, 1);
        assert.deepStrictEqual(merges[0]?.detail, {
          number: 7,
          sha: pull.headSha,
          title: "feat: add the thing",
        });
        assertDeclaredOnly(world);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F2: a pass on head A does not carry over to a force-pushed head B",
    () => {
      const world = makeWorld(actCfg);

      const pull = addPull(world, {
        number: 7,
        reviews: [
          {
            at: "2026-10-30T11:00:00Z",
            authorId: operatorId,
            body: passBody(sha("a")),
            state: "COMMENTED",
          },
        ],
      });

      pull.headSha = sha("b");
      world.checks.set(sha("b"), [
        {
          app: "github-actions",
          conclusion: "success",
          name: "checks",
          status: "completed",
        },
      ]);

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "mergeAsync"), []);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect("F1: a pass by a stranger does not merge", () => {
    const world = makeWorld(actCfg);
    addPull(world, {
      number: 7,
      reviews: [
        {
          at: "2026-10-30T11:00:00Z",
          authorId: strangerId,
          body: passBody(sha("a")),
          state: "COMMENTED",
        },
      ],
    });

    return Effect.gen(function* () {
      yield* deliver("d1", pullHint(7));
      yield* alarm;
      assert.deepStrictEqual(writesOf(world, "mergeAsync"), []);
    }).pipe(Effect.provide(botStack(world, [actCfg])));
  });

  it.effect(
    "F1 (V8): a record edited after the bot first read it stops the merge",
    () => {
      const world = makeWorld(actCfg);
      const pull = addPull(world, { number: 7 });
      world.checks.set(pull.headSha, [
        {
          app: "github-actions",
          conclusion: "success",
          name: "ci",
          status: "completed",
        },
      ]);

      return Effect.gen(function* () {
        // First sight: checks lack the required `checks` run, so no merge; the record's hash is stored.
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "mergeAsync"), []);
        // The record is edited (same author, same time, other text), and CI turns green.
        const [review] = pull.reviews;

        if (review !== undefined) {
          review.body = `${review.body}an edit by another collaborator\n`;
        }

        world.checks.set(pull.headSha, [
          {
            app: "github-actions",
            conclusion: "success",
            name: "checks",
            status: "completed",
          },
        ]);
        yield* deliver("d2", pullHint(7), "check_run");
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "mergeAsync"), []);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F11: a hold file stops every merge, and an installation suspend stops every action until unsuspend",
    () => {
      const world = makeWorld(actCfg);
      addPull(world, { number: 7 });
      world.blobs.set(".github/bot-hold", sha("9"));

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.deepStrictEqual(world.writes, []);
        world.blobs.delete(".github/bot-hold");
        yield* deliver(
          "d2",
          {
            _tag: "Installation",
            accountId: actCfg.account.id,
            action: "suspend",
          },
          "installation"
        );
        yield* deliver("d3", pullHint(7));
        yield* alarm;
        assert.deepStrictEqual(world.writes, []);
        yield* deliver(
          "d4",
          {
            _tag: "Installation",
            accountId: actCfg.account.id,
            action: "unsuspend",
          },
          "installation"
        );
        yield* deliver("d5", pullHint(7));
        yield* alarm;
        assert.strictEqual(writesOf(world, "mergeAsync").length, 1);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "D2: a rules script that drifted from its pin stops the merge and says so once",
    () => {
      const world = makeWorld(actCfg);
      addPull(world, { number: 7 });
      world.blobs.set(".agents/skills/review-pr/merge.sh", sha("7"));

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        yield* deliver("d2", pullHint(7), "check_run");
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "mergeAsync"), []);
        assert.strictEqual(writesOf(world, "createComment").length, 1);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F14: an eviction after the merge took effect leaves exactly one merge after the retry",
    () => {
      const world = makeWorld(actCfg);
      addPull(world, { number: 7 });
      world.afterMerge = () =>
        Effect.die("evicted after the call, before the receipt");

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.strictEqual(writesOf(world, "mergeAsync").length, 1);
        world.afterMerge = undefined;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.strictEqual(writesOf(world, "mergeAsync").length, 1);
        const audit = yield* ReleaseLedger.use((ledger) => ledger.auditEntries);
        assert.isTrue(audit.some((entry) => entry.kind === "work-failed"));
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F14: an eviction after the merge intent, before the call, leaves exactly one merge after the retry",
    () => {
      const world = makeWorld(actCfg);
      addPull(world, { number: 7 });
      world.beforeMerge = () =>
        Effect.die("evicted after the intent, before the call");

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "mergeAsync"), []);
        world.beforeMerge = undefined;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.strictEqual(writesOf(world, "mergeAsync").length, 1);
        const audit = yield* ReleaseLedger.use((ledger) => ledger.auditEntries);
        assert.isTrue(audit.some((entry) => entry.kind === "work-failed"));
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F14: an eviction before the comment call leaves exactly one comment after the retry",
    () => {
      const world = makeWorld(actCfg);
      addPull(world, { number: 7 });
      world.blobs.set(".agents/skills/review-pr/merge.sh", sha("7"));
      world.beforeComment = () =>
        Effect.die("evicted after the intent, before the call");

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "createComment"), []);
        world.beforeComment = undefined;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.strictEqual(writesOf(world, "createComment").length, 1);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F14: an eviction after the comment was posted, before its receipt, adds no second comment (the read-back)",
    () => {
      const world = makeWorld(actCfg);
      addPull(world, { number: 7 });
      world.blobs.set(".agents/skills/review-pr/merge.sh", sha("7"));
      world.afterComment = () =>
        Effect.die("evicted after the call, before the receipt");

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        assert.strictEqual(writesOf(world, "createComment").length, 1);
        world.afterComment = undefined;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.strictEqual(writesOf(world, "createComment").length, 1);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "a refused merge (400) is final for that head: one comment, no second call, however often it is told; a new head is a new key",
    () => {
      const world = makeWorld(actCfg);
      const pull = addPull(world, { number: 7 });
      world.mergeRefusal = "Pull Request is not mergeable";

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(7));
        yield* alarm;
        yield* deliver("d2", pullHint(7), "check_run");
        yield* alarm;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.strictEqual(writesOf(world, "mergeAsync").length, 1);
        assert.strictEqual(writesOf(world, "createComment").length, 1);
        const sql = yield* SqlClient.SqlClient;

        const receipts = yield* sql<{
          readonly key: string;
          readonly receipt: string | null;
        }>`SELECT key, receipt FROM rb_actions WHERE kind = 'merge'`;

        assert.deepStrictEqual(
          receipts.map((row) => row.key),
          [`merge:${repoName}#7@${pull.headSha}`]
        );
        assert.include(receipts[0]?.receipt ?? "", "rejected:");
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );
});

describe("release journeys", () => {
  const mergeSha = sha("e");

  const greenChecks = {
    app: "github-actions",
    conclusion: "success",
    name: "checks",
    status: "completed",
  } as const;

  it.effect(
    "F7, F8 and F17: dispatch, one approval link, one report with the publisher per package",
    () => {
      const world = makeWorld(actCfg);
      const pull = versionPr(world, 18, sha("c"), mergeSha);
      pull.files = [
        { filename: "packages/core/package.json", status: "modified" },
        { filename: "packages/harness/package.json", status: "modified" },
        { filename: "README.md", status: "modified" },
      ];
      world.mainHead = mergeSha;
      world.checks.set(mergeSha, [
        {
          app: "github-actions",
          conclusion: "success",
          name: "checks",
          status: "completed",
        },
      ]);
      world.texts.set(
        `packages/core/package.json@${mergeSha}`,
        '{"name":"@pg-txmode/core","version":"0.1.0-alpha.2"}'
      );
      world.texts.set(
        `packages/harness/package.json@${mergeSha}`,
        '{"name":"@pg-txmode/harness","private":true,"version":"0.0.0"}'
      );

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(18));
        yield* alarm;
        const dispatches = writesOf(world, "dispatchWorkflow");
        assert.strictEqual(dispatches.length, 1);
        assert.deepStrictEqual(dispatches[0]?.detail, {
          inputs: { mode: "publish" },
          ref: "main",
          workflow: "release.yml",
        });

        // The run reaches the environment gate: one approval comment, however often GitHub says so.
        const [run] = [...world.runs.values()];
        assert.isDefined(run);

        if (run === undefined) {
          return;
        }

        world.runs.set(run.id, { ...run, status: "waiting" });
        yield* deliver("d2", runHint(run.id), "workflow_job");
        yield* alarm;
        yield* deliver("d3", runHint(run.id), "workflow_job");
        yield* alarm;

        const approvals = pull.comments.filter((comment) =>
          comment.body.includes("waiting for **your** approval")
        );

        assert.strictEqual(approvals.length, 1);
        assert.include(approvals[0]?.body ?? "", run.html_url);

        // The run ends: one report, publisher read from the registry (the captured alpha.2 document is the OIDC one).
        world.runs.set(run.id, {
          ...run,
          conclusion: "success",
          status: "completed",
        });
        yield* deliver("d4", runHint(run.id), "workflow_run");
        yield* alarm;
        yield* deliver("d5", runHint(run.id), "workflow_run");
        yield* alarm;

        const reports = pull.comments.filter((comment) =>
          comment.body.includes("ended: **success**")
        );

        assert.strictEqual(reports.length, 1);
        assert.include(
          reports[0]?.body ?? "",
          "`@pg-txmode/core@0.1.0-alpha.2`: OIDC (trusted publisher)"
        );
        assert.notInclude(reports[0]?.body ?? "", "harness");
        assert.strictEqual(writesOf(world, "dispatchWorkflow").length, 1);
        assertDeclaredOnly(world);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F17: a version that the registry shows as a token publish is reported as token",
    () => {
      const world = makeWorld(actCfg);
      const pull = versionPr(world, 18, sha("c"), mergeSha);
      pull.files = [
        { filename: "packages/core/package.json", status: "modified" },
      ];
      world.mainHead = mergeSha;
      world.checks.set(mergeSha, [
        {
          app: "github-actions",
          conclusion: "success",
          name: "checks",
          status: "completed",
        },
      ]);
      world.texts.set(
        `packages/core/package.json@${mergeSha}`,
        '{"name":"@pg-txmode/core","version":"0.1.0-alpha.0"}'
      );

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(18));
        yield* alarm;
        const [run] = [...world.runs.values()];

        if (run === undefined) {
          return assert.fail("no run");
        }

        world.runs.set(run.id, {
          ...run,
          conclusion: "success",
          status: "completed",
        });
        yield* deliver("d2", runHint(run.id), "workflow_run");
        yield* alarm;
        assert.include(
          pull.comments.at(-1)?.body ?? "",
          "`@pg-txmode/core@0.1.0-alpha.0`: token"
        );
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F9: main moved past the merge commit, so no dispatch and one explanation",
    () => {
      const world = makeWorld(actCfg);
      const pull = versionPr(world, 18, sha("c"), mergeSha);
      world.mainHead = sha("f");
      world.checks.set(mergeSha, [
        {
          app: "github-actions",
          conclusion: "success",
          name: "checks",
          status: "completed",
        },
      ]);

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(18));
        yield* alarm;
        yield* deliver("d2", pullHint(18), "check_run");
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "dispatchWorkflow"), []);
        assert.strictEqual(
          pull.comments.filter((comment) => comment.body.includes("MainMoved"))
            .length,
          1
        );
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F9: while a version PR waits for its dispatch, other merges wait; the lock ends on the timeout",
    () => {
      const world = makeWorld(actCfg);
      addPull(world, {
        headSha: sha("c"),
        number: 18,
        reviews: [
          {
            at: "2026-10-30T11:00:00Z",
            authorId: operatorId,
            body: passBody(sha("c")),
            state: "COMMENTED",
          },
        ],
        title: "chore(release): version packages 0.1.0-alpha.3",
      });
      addPull(world, {
        headSha: sha("d"),
        number: 19,
        reviews: [
          {
            at: "2026-10-30T11:00:00Z",
            authorId: operatorId,
            body: passBody(sha("d")),
            state: "COMMENTED",
          },
        ],
      });

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(18));
        yield* alarm;
        assert.strictEqual(writesOf(world, "mergeAsync").length, 1);
        // `checks` on the merge commit never reports: the version PR is merged, the dispatch waits, the lock holds #19.
        yield* deliver("d2", pullHint(19));
        yield* alarm;
        assert.strictEqual(writesOf(world, "mergeAsync").length, 1);
        assert.deepStrictEqual(writesOf(world, "dispatchWorkflow"), []);
        // After the lock timeout (30 minutes) the dispatch is withheld with one comment and #19 may merge.
        yield* TestClock.adjust("31 minutes");
        yield* alarm;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "dispatchWorkflow"), []);
        assert.strictEqual(writesOf(world, "mergeAsync").length, 2);
        const comments = world.pulls.get(18)?.comments ?? [];
        assert.strictEqual(
          comments.filter((comment) => comment.body.includes("did not finish"))
            .length,
          1
        );
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F14: an eviction after the dispatch left, before its receipt, leaves exactly one dispatch and one run record",
    () => {
      const world = makeWorld(actCfg);
      versionPr(world, 18, sha("c"), mergeSha);
      world.mainHead = mergeSha;
      world.checks.set(mergeSha, [
        {
          app: "github-actions",
          conclusion: "success",
          name: "checks",
          status: "completed",
        },
      ]);
      world.afterDispatch = () =>
        Effect.die("evicted after the call, before the receipt");

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(18));
        yield* alarm;
        assert.strictEqual(writesOf(world, "dispatchWorkflow").length, 1);
        world.afterDispatch = undefined;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.strictEqual(writesOf(world, "dispatchWorkflow").length, 1);
        const open = yield* ReleaseLedger.use((ledger) => ledger.openRuns);
        assert.strictEqual(open.length, 1);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F14: an eviction after the dispatch intent, before the call, leaves exactly one dispatch after the retry",
    () => {
      const world = makeWorld(actCfg);
      versionPr(world, 18, sha("c"), mergeSha);
      world.mainHead = mergeSha;
      world.checks.set(mergeSha, [greenChecks]);
      world.beforeDispatch = () =>
        Effect.die("evicted after the intent, before the call");

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(18));
        yield* alarm;
        assert.deepStrictEqual(writesOf(world, "dispatchWorkflow"), []);
        world.beforeDispatch = undefined;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.strictEqual(writesOf(world, "dispatchWorkflow").length, 1);
        const open = yield* ReleaseLedger.use((ledger) => ledger.openRuns);
        assert.strictEqual(open.length, 1);
      }).pipe(Effect.provide(botStack(world, [actCfg])));
    }
  );

  it.effect(
    "F11: a merged version PR in observe mode dispatches nothing and says nothing; the verdict is NotActing",
    () => {
      const world = makeWorld(observeCfg);
      versionPr(world, 18, sha("c"), mergeSha);
      world.mainHead = mergeSha;
      world.checks.set(mergeSha, [greenChecks]);

      return Effect.gen(function* () {
        yield* deliver("d1", pullHint(18));
        yield* alarm;
        yield* TestClock.adjust("2 minutes");
        yield* alarm;
        assert.deepStrictEqual(world.writes, []);
        const audit = yield* ReleaseLedger.use((ledger) => ledger.auditEntries);

        const verdict = audit.find(
          (entry) => entry.kind === "dispatch-verdict"
        );

        assert.isDefined(verdict);
        assert.include(verdict?.detail ?? "", "NotActing");
        assertDeclaredOnly(world);
      }).pipe(Effect.provide(botStack(world, [observeCfg])));
    }
  );

  it.effect("F16: every idempotency key names its repository", () => {
    const world = makeWorld(actCfg);
    addPull(world, { number: 7 });

    return Effect.gen(function* () {
      yield* deliver("d1", pullHint(7));
      yield* alarm;
      const sql = yield* SqlClient.SqlClient;

      const keys = yield* sql<{
        readonly key: string;
      }>`SELECT key FROM rb_actions`;

      assert.isAbove(keys.length, 0);

      for (const row of keys) {
        assert.include(row.key, repoName);
      }
    }).pipe(Effect.provide(botStack(world, [actCfg])));
  });
});
