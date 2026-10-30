import { Clock, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type { Hint } from "./Hint.ts";
import { HintJson } from "./Hint.ts";

/**
 * The Durable Object's tables (spec 0000, D9), behind one service. Guarantees, per table:
 * - `rb_deliveries`: **admitted** = the row is committed before the Worker answers 202; a duplicate id is a conflict.
 * - `rb_work`: at-least-once wake-ups for the alarm; a hint that arrives while its item is being processed is not lost.
 * - `rb_actions`: the idempotency ledger. **Intent before effect**: the row is written, then the call leaves; a second
 *   evaluation that finds an intent without a receipt reads the outcome back instead of calling again.
 * - `rb_records`: the sha256 of a record body when the bot first read it (V8).
 * - `rb_runs`, `rb_locks`, `rb_flags`: per-run and per-repository state; derived, rebuildable by a sweep, never a source of truth.
 * - `rb_audit`: append-only; SQLite triggers reject UPDATE and DELETE.
 * A SQL failure is a defect here (the repository's contract promises no SQL errors). No secret is ever written to a table.
 */

export interface WorkItem {
  readonly id: number;
  readonly hint: Hint;
  readonly attempts: number;
}

export type ClaimResult =
  | { readonly _tag: "Claimed" }
  | {
      readonly _tag: "Exists";
      readonly receipt: string | undefined;
      readonly intentAt: number;
    };

export interface RunRecord {
  readonly repository: string;
  readonly runId: number;
  readonly prNumber: number;
  readonly mergeSha: string;
  readonly mode: string;
  readonly htmlUrl: string;
  /** `Dispatched` (run created), `Waiting` (approval comment posted), `Concluded` (finished; report pending), `Reported`. */
  readonly state: "Dispatched" | "Waiting" | "Concluded" | "Reported";
  readonly conclusion: string | undefined;
  readonly createdAt: number;
}

export interface ReleaseLock {
  readonly repository: string;
  readonly prNumber: number;
  readonly mergeSha: string;
  readonly finalHeadSha: string;
  readonly title: string;
  readonly mergedAt: number;
}

export interface AuditEntry {
  readonly kind: string;
  readonly repository?: string;
  readonly subject?: string;
  readonly deliveryId?: string;
  /** JSON text: the facts and the verdict. Never a secret. */
  readonly detail: string;
}

const ddl: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rb_deliveries (delivery_id TEXT PRIMARY KEY, event TEXT NOT NULL, action TEXT NOT NULL, repository TEXT, received_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rb_work (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL UNIQUE, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, claimed INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 0, retry_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS rb_actions (key TEXT PRIMARY KEY, kind TEXT NOT NULL, intent_at INTEGER NOT NULL, receipt TEXT, receipt_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS rb_records (repository TEXT NOT NULL, pr_number INTEGER NOT NULL, record_key TEXT NOT NULL, body_sha256 TEXT NOT NULL, first_seen_at INTEGER NOT NULL, PRIMARY KEY (repository, pr_number, record_key))`,
  `CREATE TABLE IF NOT EXISTS rb_runs (repository TEXT NOT NULL, run_id INTEGER NOT NULL, pr_number INTEGER NOT NULL, merge_sha TEXT NOT NULL, mode TEXT NOT NULL, html_url TEXT NOT NULL, state TEXT NOT NULL, conclusion TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (repository, run_id))`,
  `CREATE TABLE IF NOT EXISTS rb_locks (repository TEXT PRIMARY KEY, pr_number INTEGER NOT NULL, merge_sha TEXT NOT NULL, final_head_sha TEXT NOT NULL, title TEXT NOT NULL, merged_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rb_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rb_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, repository TEXT, subject TEXT, delivery_id TEXT, detail TEXT NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS rb_audit_no_update BEFORE UPDATE ON rb_audit BEGIN SELECT RAISE(ABORT, 'rb_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS rb_audit_no_delete BEFORE DELETE ON rb_audit BEGIN SELECT RAISE(ABORT, 'rb_audit is append-only'); END`,
];

interface WorkRow {
  readonly id: number;
  readonly subject: string;
  readonly attempts: number;
}

interface ActionRow {
  readonly receipt: string | null;
  readonly intent_at: number;
}

interface RunRow {
  readonly repository: string;
  readonly run_id: number;
  readonly pr_number: number;
  readonly merge_sha: string;
  readonly mode: string;
  readonly html_url: string;
  readonly state: RunRecord["state"];
  readonly conclusion: string | null;
  readonly created_at: number;
}

interface LockRow {
  readonly repository: string;
  readonly pr_number: number;
  readonly merge_sha: string;
  readonly final_head_sha: string;
  readonly title: string;
  readonly merged_at: number;
}

const runOf = (row: RunRow): RunRecord => ({
  conclusion: row.conclusion ?? undefined,
  createdAt: row.created_at,
  htmlUrl: row.html_url,
  mergeSha: row.merge_sha,
  mode: row.mode,
  prNumber: row.pr_number,
  repository: row.repository,
  runId: row.run_id,
  state: row.state,
});

export class ReleaseLedger extends Context.Service<
  ReleaseLedger,
  {
    readonly admit: (input: {
      readonly deliveryId: string;
      readonly event: string;
      readonly action: string;
      readonly hint: Hint;
    }) => Effect.Effect<"admitted" | "duplicate">;
    readonly enqueue: (hint: Hint, dueAt: number) => Effect.Effect<void>;
    /** At the start of an alarm: any item still claimed belongs to an alarm that was evicted mid-run, so it is released. */
    readonly releaseClaims: Effect.Effect<void>;
    /** Items that are due and not being processed; marks them claimed. */
    readonly claimDue: (limit: number) => Effect.Effect<readonly WorkItem[]>;
    readonly completeWork: (id: number) => Effect.Effect<void>;
    readonly failWork: (id: number, nextDueAt: number) => Effect.Effect<void>;
    readonly nextDueAt: Effect.Effect<number | undefined>;
    readonly claimAction: (
      key: string,
      kind: string
    ) => Effect.Effect<ClaimResult>;
    readonly recordReceipt: (
      key: string,
      receipt: string
    ) => Effect.Effect<void>;
    /** Delete an intent that never produced a receipt, so that a new attempt can claim the key (dispatch, after a read-back found nothing). */
    readonly abandonIntent: (key: string) => Effect.Effect<void>;
    readonly recordHashes: (
      repository: string,
      prNumber: number
    ) => Effect.Effect<ReadonlyMap<string, string>>;
    readonly rememberRecords: (
      repository: string,
      prNumber: number,
      entries: readonly { readonly key: string; readonly sha256: string }[]
    ) => Effect.Effect<void>;
    readonly saveRun: (run: RunRecord) => Effect.Effect<void>;
    readonly findRun: (
      repository: string,
      runId: number
    ) => Effect.Effect<RunRecord | undefined>;
    readonly openRuns: Effect.Effect<readonly RunRecord[]>;
    readonly runsFor: (
      repository: string,
      mergeSha: string
    ) => Effect.Effect<readonly RunRecord[]>;
    /**
     * The receipt of a merge and, for a version PR, the release lock it starts, in one transaction: an eviction cannot leave the
     * receipt without the lock, so the dispatch stays guarded by it (F9, F14).
     */
    readonly recordMerge: (
      key: string,
      receipt: string,
      lock: ReleaseLock | undefined
    ) => Effect.Effect<void>;
    readonly getLock: (
      repository: string
    ) => Effect.Effect<ReleaseLock | undefined>;
    readonly clearLock: (repository: string) => Effect.Effect<void>;
    readonly allLocks: Effect.Effect<readonly ReleaseLock[]>;
    readonly setFlag: (key: string, value: string) => Effect.Effect<void>;
    readonly getFlag: (key: string) => Effect.Effect<string | undefined>;
    readonly audit: (entry: AuditEntry) => Effect.Effect<void>;
    readonly auditEntries: Effect.Effect<
      readonly { readonly kind: string; readonly detail: string }[]
    >;
  }
>()("bot/ReleaseLedger") {
  static readonly layer = Layer.effect(
    ReleaseLedger,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      for (const statement of ddl) {
        yield* sql.unsafe(statement).pipe(Effect.orDie);
      }

      const decodeHint = Schema.decodeUnknownEffect(HintJson);
      const encodeHint = Schema.encodeEffect(HintJson);
      const now = Clock.currentTimeMillis;

      const admit = Effect.fn("ReleaseLedger.admit")(function* (input: {
        readonly deliveryId: string;
        readonly event: string;
        readonly action: string;
        readonly hint: Hint;
      }) {
        const at = yield* now;
        const subject = yield* encodeHint(input.hint);

        const repository =
          input.hint._tag === "Installation" || input.hint._tag === "Sweep"
            ? null
            : input.hint.repository;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const inserted = yield* sql<{
              readonly delivery_id: string;
            }>`INSERT INTO rb_deliveries (delivery_id, event, action, repository, received_at) VALUES (${input.deliveryId}, ${input.event}, ${input.action}, ${repository}, ${at}) ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id`;

            if (inserted.length === 0) {
              return "duplicate" as const;
            }

            yield* sql`INSERT INTO rb_work (subject, due_at) VALUES (${subject}, ${at}) ON CONFLICT (subject) DO UPDATE SET due_at = MIN(due_at, excluded.due_at), dirty = CASE WHEN claimed = 1 THEN 1 ELSE dirty END`;

            return "admitted" as const;
          })
        );
      }, Effect.orDie);

      const enqueue = Effect.fn("ReleaseLedger.enqueue")(function* (
        hint: Hint,
        dueAt: number
      ) {
        const subject = yield* encodeHint(hint);
        // Internal wake-ups (a retry of the item being processed, work for another subject): while the subject is being
        // processed they only set its `retry_at`; only a delivery (`admit`) marks it dirty, so an item that re-checks itself ends.
        yield* sql`INSERT INTO rb_work (subject, due_at) VALUES (${subject}, ${dueAt}) ON CONFLICT (subject) DO UPDATE SET due_at = CASE WHEN claimed = 1 THEN due_at ELSE MIN(due_at, excluded.due_at) END, retry_at = CASE WHEN claimed = 1 THEN MIN(COALESCE(retry_at, excluded.due_at), excluded.due_at) ELSE retry_at END`;
      }, Effect.orDie);

      const claimDue = Effect.fn("ReleaseLedger.claimDue")(function* (
        limit: number
      ) {
        const at = yield* now;

        const rows = yield* sql.withTransaction(
          Effect.gen(function* () {
            const due =
              yield* sql<WorkRow>`SELECT id, subject, attempts FROM rb_work WHERE claimed = 0 AND due_at <= ${at} ORDER BY due_at, id LIMIT ${limit}`;

            for (const row of due) {
              yield* sql`UPDATE rb_work SET claimed = 1, dirty = 0, retry_at = NULL WHERE id = ${row.id}`;
            }

            return due;
          })
        );

        return yield* Effect.forEach(rows, (row) =>
          decodeHint(row.subject).pipe(
            Effect.map((hint): WorkItem => ({
              attempts: row.attempts,
              hint,
              id: row.id,
            }))
          )
        );
      }, Effect.orDie);

      return ReleaseLedger.of({
        abandonIntent: (key) =>
          sql`DELETE FROM rb_actions WHERE key = ${key} AND receipt IS NULL`.pipe(
            Effect.orDie,
            Effect.asVoid
          ),
        admit,
        allLocks: sql<LockRow>`SELECT * FROM rb_locks`.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              finalHeadSha: row.final_head_sha,
              mergeSha: row.merge_sha,
              mergedAt: row.merged_at,
              prNumber: row.pr_number,
              repository: row.repository,
              title: row.title,
            }))
          ),
          Effect.orDie
        ),
        audit: Effect.fn("ReleaseLedger.audit")(function* (entry: AuditEntry) {
          const at = yield* now;
          yield* sql`INSERT INTO rb_audit (at, kind, repository, subject, delivery_id, detail) VALUES (${at}, ${entry.kind}, ${entry.repository ?? null}, ${entry.subject ?? null}, ${entry.deliveryId ?? null}, ${entry.detail})`.pipe(
            Effect.orDie
          );
        }),
        auditEntries: sql<{
          readonly kind: string;
          readonly detail: string;
        }>`SELECT kind, detail FROM rb_audit ORDER BY seq`.pipe(Effect.orDie),
        claimAction: Effect.fn("ReleaseLedger.claimAction")(function* (
          key: string,
          kind: string
        ) {
          const at = yield* now;

          const claimed = yield* sql<{
            readonly key: string;
          }>`INSERT INTO rb_actions (key, kind, intent_at) VALUES (${key}, ${kind}, ${at}) ON CONFLICT (key) DO NOTHING RETURNING key`.pipe(
            Effect.orDie
          );

          if (claimed.length > 0) {
            return { _tag: "Claimed" } as const;
          }

          const [existing] =
            yield* sql<ActionRow>`SELECT receipt, intent_at FROM rb_actions WHERE key = ${key}`.pipe(
              Effect.orDie
            );

          return {
            _tag: "Exists",
            intentAt: existing?.intent_at ?? at,
            receipt: existing?.receipt ?? undefined,
          } as const;
        }),
        claimDue,
        clearLock: (repository) =>
          sql`DELETE FROM rb_locks WHERE repository = ${repository}`.pipe(
            Effect.orDie,
            Effect.asVoid
          ),
        completeWork: Effect.fn("ReleaseLedger.completeWork")(function* (
          id: number
        ) {
          const at = yield* now;
          // A delivery arrived during the run (dirty): again now. An internal retry was asked for: at that time. Else done.
          yield* sql`UPDATE rb_work SET claimed = 0, dirty = 0, retry_at = NULL, due_at = ${at} WHERE id = ${id} AND dirty = 1`;
          yield* sql`UPDATE rb_work SET claimed = 0, due_at = retry_at, retry_at = NULL WHERE id = ${id} AND claimed = 1 AND retry_at IS NOT NULL`;
          yield* sql`DELETE FROM rb_work WHERE id = ${id} AND claimed = 1`;
        }, Effect.orDie),
        enqueue,
        failWork: (id, nextDueAt) =>
          sql`UPDATE rb_work SET claimed = 0, attempts = attempts + 1, due_at = ${nextDueAt} WHERE id = ${id}`.pipe(
            Effect.orDie,
            Effect.asVoid
          ),
        findRun: (repository, runId) =>
          sql<RunRow>`SELECT * FROM rb_runs WHERE repository = ${repository} AND run_id = ${runId}`.pipe(
            Effect.map((rows) =>
              rows[0] === undefined ? undefined : runOf(rows[0])
            ),
            Effect.orDie
          ),
        getFlag: (key) =>
          sql<{
            readonly value: string;
          }>`SELECT value FROM rb_flags WHERE key = ${key}`.pipe(
            Effect.map((rows) => rows[0]?.value),
            Effect.orDie
          ),
        getLock: (repository) =>
          sql<LockRow>`SELECT * FROM rb_locks WHERE repository = ${repository}`.pipe(
            Effect.map((rows) => {
              const [row] = rows;

              return row === undefined
                ? undefined
                : {
                    finalHeadSha: row.final_head_sha,
                    mergeSha: row.merge_sha,
                    mergedAt: row.merged_at,
                    prNumber: row.pr_number,
                    repository: row.repository,
                    title: row.title,
                  };
            }),
            Effect.orDie
          ),
        nextDueAt: sql<{
          readonly due: number | null;
        }>`SELECT MIN(due_at) AS due FROM rb_work WHERE claimed = 0`.pipe(
          Effect.map((rows) => rows[0]?.due ?? undefined),
          Effect.orDie
        ),
        openRuns:
          sql<RunRow>`SELECT * FROM rb_runs WHERE state != 'Reported' ORDER BY created_at`.pipe(
            Effect.map((rows) => rows.map(runOf)),
            Effect.orDie
          ),
        recordHashes: (repository, prNumber) =>
          sql<{
            readonly record_key: string;
            readonly body_sha256: string;
          }>`SELECT record_key, body_sha256 FROM rb_records WHERE repository = ${repository} AND pr_number = ${prNumber}`.pipe(
            Effect.map(
              (rows) =>
                new Map(
                  rows.map((row) => [row.record_key, row.body_sha256] as const)
                )
            ),
            Effect.orDie
          ),
        recordMerge: (key, receipt, lock) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const at = yield* now;
                yield* sql`UPDATE rb_actions SET receipt = ${receipt}, receipt_at = ${at} WHERE key = ${key}`;

                if (lock !== undefined) {
                  yield* sql`INSERT INTO rb_locks (repository, pr_number, merge_sha, final_head_sha, title, merged_at) VALUES (${lock.repository}, ${lock.prNumber}, ${lock.mergeSha}, ${lock.finalHeadSha}, ${lock.title}, ${lock.mergedAt}) ON CONFLICT (repository) DO UPDATE SET pr_number = excluded.pr_number, merge_sha = excluded.merge_sha, final_head_sha = excluded.final_head_sha, title = excluded.title, merged_at = excluded.merged_at`;
                }
              })
            )
            .pipe(Effect.orDie),
        recordReceipt: (key, receipt) =>
          Effect.gen(function* () {
            const at = yield* now;
            yield* sql`UPDATE rb_actions SET receipt = ${receipt}, receipt_at = ${at} WHERE key = ${key}`;
          }).pipe(Effect.orDie),
        releaseClaims:
          sql`UPDATE rb_work SET claimed = 0 WHERE claimed = 1`.pipe(
            Effect.orDie,
            Effect.asVoid
          ),
        rememberRecords: (repository, prNumber, entries) =>
          Effect.gen(function* () {
            const at = yield* now;

            for (const entry of entries) {
              yield* sql`INSERT INTO rb_records (repository, pr_number, record_key, body_sha256, first_seen_at) VALUES (${repository}, ${prNumber}, ${entry.key}, ${entry.sha256}, ${at}) ON CONFLICT DO NOTHING`;
            }
          }).pipe(Effect.orDie),
        runsFor: (repository, mergeSha) =>
          sql<RunRow>`SELECT * FROM rb_runs WHERE repository = ${repository} AND merge_sha = ${mergeSha} ORDER BY created_at`.pipe(
            Effect.map((rows) => rows.map(runOf)),
            Effect.orDie
          ),
        saveRun: (run) =>
          sql`INSERT INTO rb_runs (repository, run_id, pr_number, merge_sha, mode, html_url, state, conclusion, created_at) VALUES (${run.repository}, ${run.runId}, ${run.prNumber}, ${run.mergeSha}, ${run.mode}, ${run.htmlUrl}, ${run.state}, ${run.conclusion ?? null}, ${run.createdAt}) ON CONFLICT (repository, run_id) DO UPDATE SET state = excluded.state, conclusion = excluded.conclusion`.pipe(
            Effect.orDie,
            Effect.asVoid
          ),
        setFlag: (key, value) =>
          sql`INSERT INTO rb_flags (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(
            Effect.orDie,
            Effect.asVoid
          ),
      });
    })
  );
}
