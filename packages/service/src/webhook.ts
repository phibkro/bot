import type { AppEvent } from "@bot/rules";
import { Schema } from "effect";

import type { Hint } from "./Hint.ts";

/**
 * The fields of a webhook payload that the bot reads, and nothing else (spec 0000, D4). Decoded once, at the Worker, after the
 * signature verified. `interpret` turns an event into the account it belongs to and a hint, or ignores it.
 */
export const WebhookEnvelope = Schema.Struct({
  action: Schema.optional(Schema.String),
  check_run: Schema.optional(Schema.Struct({ head_sha: Schema.String })),
  installation: Schema.optional(
    Schema.Struct({
      account: Schema.optional(
        Schema.NullOr(Schema.Struct({ id: Schema.Int }))
      ),
      id: Schema.Int,
    })
  ),
  issue: Schema.optional(
    Schema.Struct({
      number: Schema.Int,
      pull_request: Schema.optional(Schema.Unknown),
    })
  ),
  number: Schema.optional(Schema.Int),
  pull_request: Schema.optional(Schema.Struct({ number: Schema.Int })),
  repository: Schema.optional(
    Schema.Struct({
      full_name: Schema.String,
      owner: Schema.Struct({ id: Schema.Int }),
    })
  ),
  sha: Schema.optional(Schema.String),
  workflow_job: Schema.optional(Schema.Struct({ run_id: Schema.Int })),
  workflow_run: Schema.optional(Schema.Struct({ id: Schema.Int })),
});

export type WebhookEnvelope = typeof WebhookEnvelope.Type;

export type Interpretation =
  | { readonly _tag: "Ignored" }
  | {
      readonly _tag: "Hint";
      /** The numeric id of the account that owns the repository or the installation: the allowlist key (spec 0000, O2). */
      readonly accountId: number;
      readonly action: string;
      readonly hint: Hint;
    };

const ignored: Interpretation = { _tag: "Ignored" };

type Subject = (
  payload: WebhookEnvelope,
  repository: string
) => Hint | undefined;

const pullSubject: Subject = (payload, repository) => {
  const number = payload.pull_request?.number ?? payload.number;

  return number === undefined
    ? undefined
    : { _tag: "Pull", number, repository };
};

const shaSubject = (
  sha: string | undefined,
  repository: string
): Hint | undefined =>
  sha === undefined ? undefined : { _tag: "Sha", repository, sha };

const runSubject = (
  runId: number | undefined,
  repository: string
): Hint | undefined =>
  runId === undefined ? undefined : { _tag: "Run", repository, runId };

/** The subject to look at again, per subscribed event; a comment counts only on a pull request. */
const subjects = {
  check_run: (payload, repository) =>
    shaSubject(payload.check_run?.head_sha, repository),
  issue_comment: (payload, repository) =>
    payload.issue?.pull_request === undefined
      ? undefined
      : { _tag: "Pull", number: payload.issue.number, repository },
  pull_request: pullSubject,
  pull_request_review: pullSubject,
  status: (payload, repository) => shaSubject(payload.sha, repository),
  workflow_job: (payload, repository) =>
    runSubject(payload.workflow_job?.run_id, repository),
  workflow_run: (payload, repository) =>
    runSubject(payload.workflow_run?.id, repository),
} as const satisfies Readonly<Record<AppEvent, Subject>>;

/** Which hint an event gives. Events outside the subscribed list, and PR-less `issue_comment`s, are ignored. */
export const interpret = (
  event: string,
  payload: WebhookEnvelope
): Interpretation => {
  const action = payload.action ?? "";
  const { repository } = payload;

  if (event === "installation") {
    const accountId = payload.installation?.account?.id;

    return accountId === undefined
      ? ignored
      : {
          _tag: "Hint",
          accountId,
          action,
          hint: { _tag: "Installation", accountId, action },
        };
  }

  if (repository === undefined) {
    return ignored;
  }

  const subject = Object.entries(subjects).find(
    ([name]) => name === event
  )?.[1](payload, repository.full_name);

  return subject === undefined
    ? ignored
    : {
        _tag: "Hint",
        accountId: repository.owner.id,
        action,
        hint: subject,
      };
};
