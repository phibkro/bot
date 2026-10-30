import {
  checkEntriesFromApi,
  decideDispatch,
  decideMerge,
  holdPaths,
  mainRelationFromApi,
  parseRecord,
  pinnedPaths,
  prFactsFromApi,
  recordsFromApi,
  releaseLock,
  classifyPublisher,
} from "@bot/rules";
import type {
  CommentKind,
  Publisher,
  DispatchFacts,
  MainRelation,
  MergeFacts,
  MergeVerdict,
  RepositoryConfig,
} from "@bot/rules";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect";
import { Digest } from "effect/crypto";

import { BotConfig } from "./BotConfig.ts";
import { GitHubError } from "./errors.ts";
import type { Pull } from "./github/GitHubApi.ts";
import { GitHubApi } from "./github/GitHubApi.ts";
import { PackageManifest } from "./github/schemas.ts";
import type { Hint } from "./Hint.ts";
import { encodeJson } from "./json.ts";
import { Narrator } from "./Narrator.ts";
import { Notifier } from "./Notifier.ts";
import { NpmRegistry } from "./NpmRegistry.ts";
import { ReleaseLedger } from "./ReleaseLedger.ts";
import type { RunRecord, WorkItem } from "./ReleaseLedger.ts";

const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PackageManifest)
);

const encoder = new TextEncoder();

/** Rules that make a refusal worth a PR comment (the others are quiet: the audit row is the record). */
const loudRefusals: ReadonlySet<string> = new Set([
  "ConflictsWithMain",
  "OverlapsMain",
  "RulesDrifted",
  "RecordChanged",
]);

const mergeabilityDelayMs = 15_000;
const lockRecheckMs = 60_000;
const dispatchReadBackAfterMs = 120_000;
const backoffBaseMs = 60_000;
const backoffCapMs = 15 * 60_000;
const maxBatchesPerAlarm = 50;

/** The wait before a failed item runs again: GitHub's own `retry-after` when it gave one, else exponential backoff to a cap. */
const retryDelayMs = (
  hintedSeconds: number | undefined,
  attempts: number
): number =>
  hintedSeconds === undefined
    ? Math.min(backoffBaseMs * 2 ** attempts, backoffCapMs)
    : hintedSeconds * 1000;

/** A run's conclusion as the dispatch rules see it: still running (`undefined`), a success, or any other end. */
const concludedOf = (
  conclusion: string | undefined
): "success" | "failed" | undefined => {
  if (conclusion === undefined) {
    return undefined;
  }

  return conclusion === "success" ? "success" : "failed";
};

/**
 * The bot (spec 0000): `deliver` admits a webhook delivery (hint) into the ledger; `alarm` drains the due work, re-reading PRs,
 * checks, runs and the registry from the API, deciding with the pure functions of `@bot/rules`, and acting through the
 * declared services. `observe` repositories decide and audit and write nothing. The alarm never throws: a failed item is
 * re-scheduled with backoff (a Durable Object alarm stops retrying after 6 failures), and an interruption propagates.
 */
export class Bot extends Context.Service<
  Bot,
  {
    readonly deliver: (input: {
      readonly deliveryId: string;
      readonly event: string;
      readonly action: string;
      readonly hint: Hint;
    }) => Effect.Effect<"admitted" | "duplicate">;
    /** Process due work; the value is the time (ms) at which the host should wake the object next, if any. */
    readonly alarm: Effect.Effect<number | undefined>;
  }
>()("bot/Bot") {
  static readonly layer = Layer.effect(
    Bot,
    Effect.gen(function* () {
      const ledger = yield* ReleaseLedger;
      const api = yield* GitHubApi;
      const notifier = yield* Notifier;
      const registry = yield* NpmRegistry;
      const narrator = yield* Narrator;
      const digest = yield* Digest.Digest;
      const settings = yield* BotConfig;
      const now = Clock.currentTimeMillis;

      const repoOf = (fullName: string) =>
        settings.repositories.find((entry) => entry.fullName === fullName);

      const audit = (
        kind: string,
        repository: string,
        subject: string,
        detail: unknown
      ) =>
        encodeJson(detail).pipe(
          Effect.flatMap((text) =>
            ledger.audit({ detail: text, kind, repository, subject })
          )
        );

      const accountSuspended = (cfg: RepositoryConfig) =>
        ledger
          .getFlag(`suspended:${cfg.account.id}`)
          .pipe(Effect.map((value) => value === "1"));

      const keyOf = (record: {
        readonly source: string;
        readonly authorId: number;
        readonly at: string;
      }) => `${record.source}|${record.authorId}|${record.at}`;

      /** The pass records, checks, head, pins and main of a PR, as `MergeFacts` (spec 0000, D1, D3, D4). */
      const gatherMergeFacts = Effect.fn("Bot.gatherMergeFacts")(function* (
        cfg: RepositoryConfig,
        pull: Pull
      ) {
        const head = pull.head.sha;

        const [reviews, comments, runs, statuses] = yield* Effect.all(
          [
            api.listReviews(cfg, pull.number),
            api.listIssueComments(cfg, pull.number),
            api.listCheckRuns(cfg, head),
            api.getCombinedStatus(cfg, head),
          ],
          { concurrency: 4 }
        );

        const recheck = yield* api.getPull(cfg, pull.number);

        const held =
          (yield* api.blobSha(cfg, holdPaths.bot, cfg.defaultBranch)) !==
          undefined;

        const pinned = yield* pinsMatch(cfg);

        const stored = yield* ledger.recordHashes(cfg.fullName, pull.number);
        const current = new Map<string, string>();

        for (const record of [
          ...reviews.map((review) => ({
            at: review.submitted_at ?? "",
            authorId: review.user?.id ?? 0,
            body: review.body ?? "",
            source: "review",
          })),
          ...comments.map((comment) => ({
            at: comment.created_at,
            authorId: comment.user?.id ?? 0,
            body: comment.body ?? "",
            source: "comment",
          })),
        ]) {
          if (parseRecord(record.body) !== undefined) {
            current.set(
              keyOf(record),
              yield* digest.digestHex(
                Digest.sha256,
                encoder.encode(record.body)
              )
            );
          }
        }

        const records = recordsFromApi(reviews, comments, (record) => {
          const key = keyOf(record);
          const before = stored.get(key);
          const after = current.get(key);

          return (
            before !== undefined && after !== undefined && before !== after
          );
        });

        const ancestry = yield* api.compare(cfg, cfg.defaultBranch, head);
        let main: MainRelation = { _tag: "Ancestor" };

        if (ancestry.behind_by > 0) {
          const base = ancestry.merge_base_commit.sha;

          const [mainSince, headSince] = yield* Effect.all(
            [
              api.compare(cfg, base, cfg.defaultBranch),
              api.compare(cfg, base, head),
            ],
            {
              concurrency: 2,
            }
          );

          const readsKey = `mergeable-reads:${cfg.fullName}#${pull.number}@${head}`;
          const mergeable = pull.mergeable ?? null;
          const before = Number((yield* ledger.getFlag(readsKey)) ?? "0");
          const reads = mergeable === null ? before + 1 : before;

          if (mergeable === null) {
            yield* ledger.setFlag(readsKey, String(reads));
          }

          main = mainRelationFromApi({
            ancestry,
            headSince,
            mainSince,
            mergeabilityReads: reads,
            mergeable,
          });
        }

        const facts: MergeFacts = {
          checks: checkEntriesFromApi(runs.check_runs, statuses.statuses),
          main,
          operatorIds: settings.operatorIds,
          pr: prFactsFromApi(pull, recheck.head.sha, cfg.defaultBranch),
          records,
          repositoryHeld: held,
          requiredChecks: cfg.requiredChecks,
          rulesPinned: pinned,
        };

        return { current, facts };
      });

      /** D2: the pinned blobs of `merge.sh`, `record-round.sh` (and `check-record.sh`) equal the live ones on the default branch. */
      const pinsMatch = Effect.fn("Bot.pinsMatch")(function* (
        cfg: RepositoryConfig
      ) {
        const wanted: readonly (readonly [string, string | undefined])[] = [
          [pinnedPaths.mergeSh, cfg.pins.mergeSh],
          [pinnedPaths.recordRound, cfg.pins.recordRound],
          [pinnedPaths.checkRecord, cfg.pins.checkRecord],
        ];

        for (const [path, pin] of wanted) {
          if (pin === undefined) {
            continue;
          }

          if ((yield* api.blobSha(cfg, path, cfg.defaultBranch)) !== pin) {
            return false;
          }
        }

        return true;
      });

      const refuseComment = (
        cfg: RepositoryConfig,
        pull: Pull,
        reason: string,
        detail: string
      ): CommentKind => ({
        _tag: "MergeRefused",
        prNumber: pull.number,
        reason: `${reason} on ${pull.head.sha.slice(0, 7)}: ${detail}`,
        repository: cfg.fullName,
        title: pull.title,
      });

      const mergeIt = Effect.fn("Bot.mergeIt")(function* (
        cfg: RepositoryConfig,
        pull: Pull,
        verdict: Extract<MergeVerdict, { _tag: "Merge" }>
      ) {
        const key = `merge:${cfg.fullName}#${pull.number}@${verdict.sha}`;
        const claim = yield* ledger.claimAction(key, "merge");

        if (claim._tag === "Exists" && claim.receipt !== undefined) {
          return;
        }

        // Claimed, or an intent without a receipt: merge-async is idempotent by construction (spec 0000, D7), so calling again is safe.
        const outcome = yield* api.merge(cfg, {
          number: pull.number,
          sha: verdict.sha,
          title: pull.title,
        });

        yield* audit("merge-outcome", cfg.fullName, `#${pull.number}`, outcome);

        if (outcome._tag === "Merged") {
          yield* ledger.recordReceipt(key, `merged:${outcome.sha}`);

          if (
            cfg.release !== undefined &&
            pull.title.startsWith(cfg.release.versionTitlePrefix)
          ) {
            yield* ledger.setLock({
              finalHeadSha: verdict.sha,
              mergeSha: outcome.sha,
              mergedAt: yield* now,
              prNumber: pull.number,
              repository: cfg.fullName,
              title: pull.title,
            });
          }

          yield* ledger.enqueue(
            { _tag: "Pull", number: pull.number, repository: cfg.fullName },
            yield* now
          );
        } else if (outcome._tag === "Pending") {
          yield* ledger.enqueue(
            { _tag: "Pull", number: pull.number, repository: cfg.fullName },
            (yield* now) + 30_000
          );
        } else {
          yield* ledger.recordReceipt(
            key,
            `${outcome._tag.toLowerCase()}:${outcome.message}`
          );
          yield* notifier.post(
            cfg,
            pull.number,
            refuseComment(cfg, pull, "merge not done", outcome.message)
          );
        }
      });

      const lockedByRelease = Effect.fn("Bot.lockedByRelease")(function* (
        cfg: RepositoryConfig,
        prNumber: number
      ) {
        const lock = yield* ledger.getLock(cfg.fullName);

        return lock !== undefined && lock.prNumber !== prNumber;
      });

      const evaluateOpenPull = Effect.fn("Bot.evaluateOpenPull")(function* (
        cfg: RepositoryConfig,
        pull: Pull
      ) {
        const { current, facts } = yield* gatherMergeFacts(cfg, pull);
        const verdict = decideMerge(facts);
        yield* audit("merge-verdict", cfg.fullName, `#${pull.number}`, {
          checks: facts.checks.map(
            (check) => `${check.name}:${check.conclusion ?? check.status}`
          ),
          head: pull.head.sha,
          main: facts.main._tag,
          mode: cfg.mode,
          verdict,
        });
        // First sight of a record fixes its hash (V8): later edits are detected against it.
        yield* ledger.rememberRecords(
          cfg.fullName,
          pull.number,
          Array.from(current, ([key, sha256]) => ({ key, sha256 }))
        );

        if (verdict._tag === "Wait") {
          if (verdict.reason === "MergeabilityUnknown") {
            yield* ledger.enqueue(
              { _tag: "Pull", number: pull.number, repository: cfg.fullName },
              (yield* now) + mergeabilityDelayMs
            );
          }

          return;
        }

        if (cfg.mode === "observe") {
          return;
        }

        if (verdict._tag === "Refuse") {
          if (loudRefusals.has(verdict.reason)) {
            yield* notifier.post(
              cfg,
              pull.number,
              refuseComment(cfg, pull, verdict.reason, "see the audit row")
            );
          }

          return;
        }

        if (yield* lockedByRelease(cfg, pull.number)) {
          yield* audit(
            "merge-held-by-release-lock",
            cfg.fullName,
            `#${pull.number}`,
            {}
          );
          yield* ledger.enqueue(
            { _tag: "Pull", number: pull.number, repository: cfg.fullName },
            (yield* now) + lockRecheckMs
          );

          return;
        }

        yield* mergeIt(cfg, pull, verdict);
      });

      /** The `checks` runs on `M`: `success` when every required name succeeded, `failed` when one concluded otherwise, else `pending`. */
      const checksOnMerge = Effect.fn("Bot.checksOnMerge")(function* (
        cfg: RepositoryConfig,
        mergeSha: string
      ) {
        const runs = yield* api.listCheckRuns(cfg, mergeSha);

        const required = cfg.requiredChecks.map((name) =>
          runs.check_runs.find((run) => run.name === name)
        );

        if (
          required.some(
            (run) => run?.status === "completed" && run.conclusion !== "success"
          )
        ) {
          return "failed" as const;
        }

        return required.every(
          (run) => run?.status === "completed" && run.conclusion === "success"
        )
          ? ("success" as const)
          : ("pending" as const);
      });

      const withheld = (
        cfg: RepositoryConfig,
        prNumber: number,
        reason: string
      ) =>
        notifier.post(cfg, prNumber, {
          _tag: "Withheld",
          prNumber,
          reason,
          repository: cfg.fullName,
        });

      const evaluateMergedPull = Effect.fn("Bot.evaluateMergedPull")(function* (
        cfg: RepositoryConfig,
        pull: Pull
      ) {
        if (
          cfg.release === undefined ||
          pull.merge_commit_sha === undefined ||
          pull.merge_commit_sha === null
        ) {
          return;
        }

        const mergeSha = pull.merge_commit_sha;

        const [reviews, comments, mainHead, onMerge, hold, runs] =
          yield* Effect.all(
            [
              api.listReviews(cfg, pull.number),
              api.listIssueComments(cfg, pull.number),
              api.branchHead(cfg, cfg.defaultBranch),
              checksOnMerge(cfg, mergeSha),
              api.blobSha(cfg, holdPaths.release, mergeSha),
              ledger.runsFor(cfg.fullName, mergeSha),
            ],
            { concurrency: 3 }
          );

        const dispatched: Partial<
          Record<
            "check" | "publish",
            { concluded: "success" | "failed" | undefined }
          >
        > = {};

        for (const run of runs) {
          if (run.mode === "check" || run.mode === "publish") {
            dispatched[run.mode] = {
              concluded: concludedOf(run.conclusion),
            };
          }
        }

        const facts: DispatchFacts = {
          acting: cfg.mode === "act",
          checksOnMerge: onMerge,
          dispatched,
          mainHeadSha: mainHead,
          operatorIds: settings.operatorIds,
          pr: {
            baseIsDefaultBranch: pull.base.ref === cfg.defaultBranch,
            finalHeadSha: pull.head.sha,
            mergeCommitSha: mergeSha,
            merged: pull.merged === true,
            title: pull.title,
          },
          // The merge already passed the V8 gate; the dispatch only needs the pass record to have existed.
          records: recordsFromApi(reviews, comments, () => false),
          release: cfg.release,
          releaseHoldPresent: hold !== undefined,
          repositoryHeld:
            (yield* api.blobSha(cfg, holdPaths.bot, cfg.defaultBranch)) !==
            undefined,
        };

        const verdict = decideDispatch(facts);
        yield* audit("dispatch-verdict", cfg.fullName, `#${pull.number}`, {
          mergeSha,
          mode: cfg.mode,
          verdict,
        });

        const lock = yield* ledger.getLock(cfg.fullName);

        if (verdict._tag === "Dispatch") {
          yield* dispatchIt(cfg, pull, mergeSha, verdict.mode);

          return;
        }

        if (verdict._tag === "Wait") {
          const ended =
            lock === undefined
              ? undefined
              : releaseLock({
                  checksOnMerge: onMerge,
                  dispatchRecorded: false,
                  mergedAtMs: lock.mergedAt,
                  nowMs: yield* now,
                  timeoutMs: cfg.release.lockTimeoutMs,
                });

          if (ended?._tag === "Unlocked") {
            yield* ledger.clearLock(cfg.fullName);
            yield* withheld(
              cfg,
              pull.number,
              `checks on the merge commit did not finish (${ended.reason})`
            );
          } else {
            yield* ledger.enqueue(
              { _tag: "Pull", number: pull.number, repository: cfg.fullName },
              (yield* now) + lockRecheckMs
            );
          }

          return;
        }

        // A Skip: the reasons that the operator should hear about end the lock with one comment; the others are quiet.
        if (
          ["MainMoved", "ChecksFailed", "ReleaseHold", "NoPassRecord"].includes(
            verdict.reason
          )
        ) {
          yield* ledger.clearLock(cfg.fullName);
          yield* withheld(
            cfg,
            pull.number,
            `the dispatch was not made: ${verdict.reason}`
          );
        } else if (verdict.reason === "AlreadyDispatched") {
          yield* ledger.clearLock(cfg.fullName);
        }
      });

      const dispatchIt = Effect.fn("Bot.dispatchIt")(function* (
        cfg: RepositoryConfig,
        pull: Pull,
        mergeSha: string,
        mode: "check" | "publish"
      ) {
        if (cfg.release === undefined) {
          return;
        }

        const key = `dispatch:${cfg.fullName}@${mergeSha}:${mode}`;
        const claim = yield* ledger.claimAction(key, "dispatch");

        if (claim._tag === "Exists" && claim.receipt !== undefined) {
          return;
        }

        if (claim._tag === "Exists") {
          // The call may or may not have left. Never a blind second dispatch: read the runs for `M` back (spec 0000, D9).
          const known = new Set(
            (yield* ledger.runsFor(cfg.fullName, mergeSha)).map(
              (run) => run.runId
            )
          );

          const found = (yield* api.listRuns(cfg, {
            headSha: mergeSha,
            workflow: cfg.release.workflow,
          })).find((run) => !known.has(run.id));

          if (found !== undefined) {
            yield* ledger.recordReceipt(key, `run:${found.id}`);
            yield* ledger.saveRun({
              conclusion: undefined,
              createdAt: yield* now,
              htmlUrl: found.html_url,
              mergeSha,
              mode,
              prNumber: pull.number,
              repository: cfg.fullName,
              runId: found.id,
              state: "Dispatched",
            });
            yield* ledger.clearLock(cfg.fullName);
            yield* ledger.enqueue(
              { _tag: "Run", repository: cfg.fullName, runId: found.id },
              yield* now
            );

            return;
          }

          if ((yield* now) - claim.intentAt < dispatchReadBackAfterMs) {
            yield* ledger.enqueue(
              { _tag: "Pull", number: pull.number, repository: cfg.fullName },
              (yield* now) + 30_000
            );

            return;
          }

          yield* ledger.abandonIntent(key);
          yield* ledger.claimAction(key, "dispatch");
        }

        const run = yield* api.dispatch(cfg, {
          inputs: { mode },
          ref: "main",
          workflow: cfg.release.workflow,
        });

        yield* ledger.recordReceipt(key, `run:${run.workflow_run_id}`);
        yield* ledger.saveRun({
          conclusion: undefined,
          createdAt: yield* now,
          htmlUrl: run.html_url,
          mergeSha,
          mode,
          prNumber: pull.number,
          repository: cfg.fullName,
          runId: run.workflow_run_id,
          state: "Dispatched",
        });
        yield* ledger.clearLock(cfg.fullName);
        yield* audit("dispatched", cfg.fullName, `run ${run.workflow_run_id}`, {
          mergeSha,
          mode,
        });
        yield* ledger.enqueue(
          { _tag: "Run", repository: cfg.fullName, runId: run.workflow_run_id },
          yield* now
        );
      });

      const evaluatePull = Effect.fn("Bot.evaluatePull")(function* (
        cfg: RepositoryConfig,
        number: number
      ) {
        const pull = yield* api.getPull(cfg, number);

        if (pull.merged === true) {
          yield* evaluateMergedPull(cfg, pull);
        } else if (pull.state === "open") {
          yield* evaluateOpenPull(cfg, pull);
        }
      });

      /** `name@version` of every non-private manifest that the version PR changed, read at `M` (spec 0000, "The report"). */
      const packagesOf = Effect.fn("Bot.packagesOf")(function* (
        cfg: RepositoryConfig,
        run: RunRecord
      ) {
        const files = yield* api.listPullFiles(cfg, run.prNumber);

        const found: {
          readonly name: string;
          readonly version: string;
        }[] = [];

        for (const file of files) {
          if (
            file.status === "removed" ||
            !/(?:^|\/)package\.json$/u.test(file.filename)
          ) {
            continue;
          }

          const text = yield* api.fileText(cfg, file.filename, run.mergeSha);

          if (text === undefined) {
            continue;
          }

          const manifest = yield* decodeManifest(text).pipe(Effect.option);

          if (manifest._tag === "Some" && manifest.value.private !== true) {
            found.push({
              name: manifest.value.name,
              version: manifest.value.version,
            });
          }
        }

        return found;
      });

      const reportRun = Effect.fn("Bot.reportRun")(function* (
        cfg: RepositoryConfig,
        run: RunRecord,
        conclusion: string
      ) {
        const at = yield* now;

        let packages: {
          name: string;
          version: string;
          publisher: Publisher;
        }[] = [];

        if (run.mode === "publish" && conclusion === "success") {
          const wanted = yield* packagesOf(cfg, run);
          packages = yield* Effect.forEach(wanted, (entry) =>
            registry.versionDoc(entry.name, entry.version).pipe(
              Effect.map((doc) => ({
                ...entry,
                publisher: classifyPublisher(doc),
              })),
              Effect.catchTag("RegistryError", () =>
                Effect.succeed({
                  ...entry,
                  publisher: "not-published" as const,
                })
              )
            )
          );

          if (
            packages.some((entry) => entry.publisher === "not-published") &&
            at - run.createdAt < settings.registryPatienceMs
          ) {
            yield* ledger.enqueue(
              { _tag: "Run", repository: cfg.fullName, runId: run.runId },
              at + 60_000
            );

            return;
          }
        }

        const narration = yield* narrator.paragraph({
          conclusion,
          kind: "report",
          repository: cfg.fullName,
          runUrl: run.htmlUrl,
        });

        yield* notifier.post(cfg, run.prNumber, {
          _tag: "Report",
          conclusion,
          mode: run.mode,
          narration: Option.getOrUndefined(narration),
          packages,
          prNumber: run.prNumber,
          repository: cfg.fullName,
          runId: run.runId,
          runUrl: run.htmlUrl,
        });
        yield* ledger.saveRun({ ...run, conclusion, state: "Reported" });
      });

      const evaluateRun = Effect.fn("Bot.evaluateRun")(function* (
        cfg: RepositoryConfig,
        runId: number
      ) {
        const run = yield* ledger.findRun(cfg.fullName, runId);

        if (run === undefined || run.state === "Reported") {
          return;
        }

        const info = yield* api.getRun(cfg, runId);

        if (info.status === "waiting" && run.state === "Dispatched") {
          yield* notifier.post(cfg, run.prNumber, {
            _tag: "Approval",
            mode: run.mode,
            prNumber: run.prNumber,
            repository: cfg.fullName,
            runId,
            runUrl: run.htmlUrl,
          });
          yield* ledger.saveRun({ ...run, state: "Waiting" });
        } else if (info.status === "completed") {
          const conclusion = info.conclusion ?? "unknown";
          yield* ledger.saveRun({ ...run, conclusion, state: "Concluded" });
          yield* reportRun(
            cfg,
            { ...run, conclusion, state: "Concluded" },
            conclusion
          );
        }
      });

      const evaluateSha = Effect.fn("Bot.evaluateSha")(function* (
        cfg: RepositoryConfig,
        sha: string
      ) {
        const open = yield* api.listOpenPulls(cfg);

        for (const entry of open.filter(
          (candidate) => candidate.head.sha === sha
        )) {
          yield* ledger.enqueue(
            { _tag: "Pull", number: entry.number, repository: cfg.fullName },
            yield* now
          );
        }

        const lock = yield* ledger.getLock(cfg.fullName);

        if (lock !== undefined && lock.mergeSha === sha) {
          yield* ledger.enqueue(
            { _tag: "Pull", number: lock.prNumber, repository: cfg.fullName },
            yield* now
          );
        }
      });

      /** D4: the reconcile sweep re-reads every open PR, every lock and every open run, so a missed webhook is repaired. */
      const sweep = Effect.fn("Bot.sweep")(function* () {
        const at = yield* now;

        for (const cfg of settings.repositories) {
          if (yield* accountSuspended(cfg)) {
            continue;
          }

          for (const entry of yield* api.listOpenPulls(cfg)) {
            yield* ledger.enqueue(
              { _tag: "Pull", number: entry.number, repository: cfg.fullName },
              at
            );
          }

          const lock = yield* ledger.getLock(cfg.fullName);

          if (lock !== undefined) {
            yield* ledger.enqueue(
              { _tag: "Pull", number: lock.prNumber, repository: cfg.fullName },
              at
            );
          }
        }

        for (const run of yield* ledger.openRuns) {
          yield* ledger.enqueue(
            { _tag: "Run", repository: run.repository, runId: run.runId },
            at
          );
        }
      });

      const processItem = Effect.fn("Bot.processItem")(function* (
        item: WorkItem
      ) {
        const { hint } = item;

        if (hint._tag === "Sweep") {
          return yield* sweep();
        }

        if (hint._tag === "Installation") {
          // The kill switch of the installation (spec 0000, "Kill switch"): suspend and delete stop every action until unsuspend.
          const stopped =
            hint.action === "suspend" || hint.action === "deleted";

          yield* ledger.setFlag(
            `suspended:${hint.accountId}`,
            stopped ? "1" : "0"
          );

          return yield* audit(
            "installation",
            String(hint.accountId),
            hint.action,
            { stopped }
          );
        }

        const cfg = repoOf(hint.repository);

        if (cfg === undefined || (yield* accountSuspended(cfg))) {
          return yield* audit("skipped", hint.repository, hint._tag, {
            reason:
              cfg === undefined ? "not configured" : "installation suspended",
          });
        }

        if (hint._tag === "Pull") {
          return yield* evaluatePull(cfg, hint.number);
        }

        if (hint._tag === "Sha") {
          return yield* evaluateSha(cfg, hint.sha);
        }

        return yield* evaluateRun(cfg, hint.runId);
      });

      const alarm = Effect.gen(function* () {
        yield* ledger.releaseClaims;

        // A bound on the batches of one alarm: an item that keeps scheduling itself for now cannot hold the object forever.
        for (let batch = 0; batch < maxBatchesPerAlarm; batch += 1) {
          const items = yield* ledger.claimDue(10);

          if (items.length === 0) {
            break;
          }

          for (const item of items) {
            const exit = yield* Effect.exit(processItem(item));

            if (Exit.isSuccess(exit)) {
              yield* ledger.completeWork(item.id);

              if (item.hint._tag === "Sweep") {
                yield* ledger.enqueue(
                  { _tag: "Sweep" },
                  (yield* now) + settings.sweepIntervalMs
                );
              }
            } else if (Cause.hasInterrupts(exit.cause)) {
              return yield* Effect.interrupt;
            } else {
              // Expected failures and defects alike: audit, back off, never let the alarm throw (it would stop retrying after 6).
              const failure = Cause.squash(exit.cause);
              yield* audit("work-failed", "-", item.hint._tag, {
                attempts: item.attempts,
                error: String(failure),
              });
              yield* ledger.failWork(
                item.id,
                (yield* now) +
                  retryDelayMs(
                    Schema.is(GitHubError)(failure)
                      ? failure.retryAfterSeconds
                      : undefined,
                    item.attempts
                  )
              );
            }
          }
        }

        return yield* ledger.nextDueAt;
      });

      const deliver = Effect.fn("Bot.deliver")(function* (input: {
        readonly deliveryId: string;
        readonly event: string;
        readonly action: string;
        readonly hint: Hint;
      }) {
        const result = yield* ledger.admit(input);
        yield* ledger.enqueue(
          { _tag: "Sweep" },
          (yield* now) + settings.sweepIntervalMs
        );

        return result;
      });

      return Bot.of({ alarm, deliver });
    })
  );
}
