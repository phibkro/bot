import { SqliteClient } from "@effect/sql-sqlite-bun";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { ReleaseLedger } from "../src/index.ts";
import type { ClaimResult, Hint } from "../src/index.ts";

/** The ledger on a real SQLite database (spec 0000, D9): admission, work, intent-before-effect, audit, records. */

const layer = ReleaseLedger.layer.pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
);

const receiptOf = (claim: ClaimResult): string | undefined =>
  claim._tag === "Exists" ? claim.receipt : undefined;

const pull: Hint = { _tag: "Pull", number: 7, repository: "o/r" };

const delivery = (deliveryId: string, hint: Hint = pull) => ({
  action: "submitted",
  deliveryId,
  event: "pull_request_review",
  hint,
});

describe("deliveries and work", () => {
  it.effect(
    "F4: a delivery id is admitted once; a redelivery is a duplicate and adds no work",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        assert.strictEqual(yield* ledger.admit(delivery("d1")), "admitted");
        assert.strictEqual(yield* ledger.admit(delivery("d1")), "duplicate");
        assert.strictEqual((yield* ledger.claimDue(10)).length, 1);
        assert.strictEqual((yield* ledger.claimDue(10)).length, 0);
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "a delivery that arrives while its item is being processed is not lost",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        yield* ledger.admit(delivery("d1"));
        const [item] = yield* ledger.claimDue(10);
        assert.isDefined(item);
        yield* ledger.admit(delivery("d2"));
        yield* ledger.completeWork(item?.id ?? 0);
        assert.strictEqual((yield* ledger.claimDue(10)).length, 1);
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "an item that asks for its own retry runs again at that time, and an item that does not is finished",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        yield* ledger.admit(delivery("d1"));
        const [item] = yield* ledger.claimDue(10);
        yield* ledger.enqueue(pull, 60_000);
        yield* ledger.completeWork(item?.id ?? 0);
        assert.strictEqual((yield* ledger.claimDue(10)).length, 0);
        assert.strictEqual(yield* ledger.nextDueAt, 60_000);
        yield* TestClock.adjust("61 seconds");
        const [again] = yield* ledger.claimDue(10);
        yield* ledger.completeWork(again?.id ?? 0);
        assert.strictEqual(yield* ledger.nextDueAt, undefined);
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "claims of an alarm that was evicted are released, and a failed item backs off",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        yield* ledger.admit(delivery("d1"));
        const [item] = yield* ledger.claimDue(10);
        assert.strictEqual((yield* ledger.claimDue(10)).length, 0);
        yield* ledger.releaseClaims;
        const [reclaimed] = yield* ledger.claimDue(10);
        assert.strictEqual(reclaimed?.id, item?.id);
        yield* ledger.failWork(reclaimed?.id ?? 0, 5000);
        assert.strictEqual((yield* ledger.claimDue(10)).length, 0);
        yield* TestClock.adjust("6 seconds");
        const [retry] = yield* ledger.claimDue(10);
        assert.strictEqual(retry?.attempts, 1);
      }).pipe(Effect.provide(layer))
  );
});

describe("actions (intent before effect)", () => {
  it.effect(
    "a key is claimed once; the second claim sees the receipt, or the intent without one",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        assert.strictEqual(
          (yield* ledger.claimAction("merge:o/r#7@a", "merge"))._tag,
          "Claimed"
        );
        const pending = yield* ledger.claimAction("merge:o/r#7@a", "merge");
        assert.deepStrictEqual(
          pending._tag === "Exists" ? pending.receipt : "claimed",
          undefined
        );
        yield* ledger.recordReceipt("merge:o/r#7@a", "merged:abc");
        const done = yield* ledger.claimAction("merge:o/r#7@a", "merge");
        assert.deepStrictEqual(
          done._tag === "Exists" ? done.receipt : "claimed",
          "merged:abc"
        );
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "an intent that never produced a receipt can be abandoned; a receipt cannot",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        yield* ledger.claimAction("k1", "dispatch");
        yield* ledger.abandonIntent("k1");
        assert.strictEqual(
          (yield* ledger.claimAction("k1", "dispatch"))._tag,
          "Claimed"
        );
        yield* ledger.recordReceipt("k1", "run:1");
        yield* ledger.abandonIntent("k1");
        assert.strictEqual(
          (yield* ledger.claimAction("k1", "dispatch"))._tag,
          "Exists"
        );
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "F9, F14: the merge receipt and the release lock are one transaction; a failing lock write leaves no receipt",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        const sql = yield* SqlClient.SqlClient;

        const lock = {
          finalHeadSha: "a".repeat(40),
          mergeSha: "b".repeat(40),
          mergedAt: 1,
          prNumber: 18,
          repository: "o/r",
          title: "chore(release): version packages",
        };

        yield* ledger.claimAction("m1", "merge");
        yield* ledger.recordMerge("m1", "merged:b", lock);
        assert.deepStrictEqual((yield* ledger.getLock("o/r"))?.prNumber, 18);
        assert.deepStrictEqual(
          receiptOf(yield* ledger.claimAction("m1", "merge")),
          "merged:b"
        );

        // The lock write fails inside the transaction (a trigger, as a full disk or an eviction would): the receipt is rolled back.
        yield* sql`CREATE TRIGGER refuse_lock BEFORE INSERT ON rb_locks BEGIN SELECT RAISE(ABORT, 'no lock'); END`;
        yield* ledger.clearLock("o/r");
        yield* ledger.claimAction("m2", "merge");

        const failed = yield* Effect.exit(
          ledger.recordMerge("m2", "merged:c", { ...lock, prNumber: 19 })
        );

        assert.isTrue(Exit.isFailure(failed));
        assert.strictEqual(
          receiptOf(yield* ledger.claimAction("m2", "merge")),
          undefined
        );
        assert.isUndefined(yield* ledger.getLock("o/r"));
      }).pipe(Effect.provide(layer))
  );
});

describe("audit and records", () => {
  it.effect(
    "the audit log is append-only: an UPDATE or a DELETE is refused by the database",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        const sql = yield* SqlClient.SqlClient;
        yield* ledger.audit({ detail: "{}", kind: "k" });

        const update = yield* sql`UPDATE rb_audit SET kind = 'x'`.pipe(
          Effect.flip
        );

        const remove = yield* sql`DELETE FROM rb_audit`.pipe(Effect.flip);
        assert.strictEqual(update._tag, "SqlError");
        assert.strictEqual(remove._tag, "SqlError");
        assert.deepStrictEqual(yield* ledger.auditEntries, [
          { detail: "{}", kind: "k" },
        ]);
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "the first sight of a record body is kept; a later sight does not replace it",
    () =>
      Effect.gen(function* () {
        const ledger = yield* ReleaseLedger;
        yield* ledger.rememberRecords("o/r", 7, [
          { key: "review|1|t", sha256: "aaa" },
        ]);
        yield* ledger.rememberRecords("o/r", 7, [
          { key: "review|1|t", sha256: "bbb" },
        ]);
        assert.strictEqual(
          (yield* ledger.recordHashes("o/r", 7)).get("review|1|t"),
          "aaa"
        );
      }).pipe(Effect.provide(layer))
  );

  it.effect(
    "no table holds a secret: the schema has no column for one, and the tables are namespaced",
    () =>
      Effect.gen(function* () {
        yield* ReleaseLedger;
        const sql = yield* SqlClient.SqlClient;

        const tables = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;

        for (const table of tables) {
          assert.isTrue(table.name.startsWith("rb_"), table.name);
        }

        const columns = yield* sql<{
          readonly name: string;
        }>`SELECT m.name AS name FROM sqlite_master t, pragma_table_info(t.name) m WHERE t.type = 'table'`;

        for (const column of columns) {
          assert.notMatch(
            column.name,
            /secret|token|key_pem|private|password/u
          );
        }
      }).pipe(Effect.provide(layer))
  );
});
