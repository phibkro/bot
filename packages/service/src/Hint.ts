import { Schema } from "effect";

/**
 * What a webhook delivery tells the bot to look at again (spec 0000, D4: webhooks are hints, the API is the truth). A hint
 * names a repository and one subject; it never carries a fact the bot acts on.
 */
export const Hint = Schema.Union([
  Schema.TaggedStruct("Pull", {
    number: Schema.Int,
    repository: Schema.String,
  }),
  Schema.TaggedStruct("Sha", { repository: Schema.String, sha: Schema.String }),
  Schema.TaggedStruct("Run", { repository: Schema.String, runId: Schema.Int }),
  Schema.TaggedStruct("Installation", {
    accountId: Schema.Int,
    action: Schema.String,
  }),
  Schema.TaggedStruct("Sweep", {}),
]);

export type Hint = typeof Hint.Type;

/** The row/JSON form of a hint, decoded where it is read back from the ledger. */
export const HintJson = Schema.fromJsonString(Hint);

/** The repository a hint concerns, when it has one. */
export const hintRepository = (hint: Hint): string | undefined =>
  hint._tag === "Installation" || hint._tag === "Sweep"
    ? undefined
    : hint.repository;
