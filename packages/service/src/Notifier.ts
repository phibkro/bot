import { commentKey, renderComment } from "@bot/rules";
import type { CommentKind, RepositoryConfig } from "@bot/rules";
import { Context, Effect, Layer } from "effect";

import type { GitHubFailure } from "./github/GitHubApi.ts";
import { GitHubApi } from "./github/GitHubApi.ts";
import { ReleaseLedger } from "./ReleaseLedger.ts";

/**
 * The operator notification channel (spec 0000, D8): one PR comment per `(repository, PR, kind, subject)`. Telegram or ntfy later
 * implement the same service. Exactly-once is not claimed: the intent is written first, and an intent without a receipt is
 * resolved by looking for the comment's own marker before posting again, so a restart or a redelivery adds no second comment (F8).
 */
export class Notifier extends Context.Service<
  Notifier,
  {
    readonly post: (
      repo: RepositoryConfig,
      prNumber: number,
      comment: CommentKind
    ) => Effect.Effect<"posted" | "already", GitHubFailure>;
  }
>()("bot/Notifier") {
  static readonly layer = Layer.effect(
    Notifier,
    Effect.gen(function* () {
      const api = yield* GitHubApi;
      const ledger = yield* ReleaseLedger;

      const post = Effect.fn("Notifier.post")(function* (
        repo: RepositoryConfig,
        prNumber: number,
        comment: CommentKind
      ) {
        const key = commentKey(comment);
        const claim = yield* ledger.claimAction(key, "comment");

        if (claim._tag === "Exists" && claim.receipt !== undefined) {
          return "already" as const;
        }

        if (claim._tag === "Exists") {
          // An intent without a receipt: the comment may exist. Read it back before posting again.
          const existing = yield* api.listIssueComments(repo, prNumber);
          const marker = `key=${key} -->`;

          const found = existing.find(
            (entry) =>
              entry.body?.startsWith("<!-- release-bot") === true &&
              entry.body.includes(marker)
          );

          if (found !== undefined) {
            yield* ledger.recordReceipt(key, `comment:${found.id}`);

            return "already" as const;
          }
        }

        const id = yield* api.createComment(
          repo,
          prNumber,
          renderComment(comment)
        );

        yield* ledger.recordReceipt(key, `comment:${id}`);

        return "posted" as const;
      });

      return Notifier.of({ post });
    })
  );
}
