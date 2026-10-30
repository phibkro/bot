import { Schema } from "effect";

/** Expected failures of the bot's services. Each carries what a handler needs; a foreign cause sits in `cause` for diagnosis only. */

/** A request to GitHub failed: transport, a status the operation does not accept, or a rate limit. */
export class GitHubError extends Schema.TaggedError<
  GitHubError,
  { readonly brand: unique symbol }
>()("GitHubError", {
  message: Schema.String,
  operation: Schema.String,
  /** Seconds to wait before a retry, from `retry-after` or the rate-limit reset, when GitHub gave one. */
  retryAfterSeconds: Schema.optional(Schema.Finite),
  status: Schema.optional(Schema.Int),
}) {}

/** A response did not have the shape the operation decodes (spec 0000, D11): a defect-grade finding, audited, never acted on. */
export class DecodeFailure extends Schema.TaggedError<
  DecodeFailure,
  { readonly brand: unique symbol }
>()("DecodeFailure", {
  message: Schema.String,
  operation: Schema.String,
}) {}

/** The egress guard refused a request that is not in the declared table of `(method, path)` pairs (spec 0000, F6). */
export class EgressDenied extends Schema.TaggedError<
  EgressDenied,
  { readonly brand: unique symbol }
>()("EgressDenied", {
  method: Schema.String,
  path: Schema.String,
}) {}

/** The App could not authenticate: the key did not import, the JWT could not be signed, or no installation was found. */
export class AppAuthError extends Schema.TaggedError<
  AppAuthError,
  { readonly brand: unique symbol }
>()("AppAuthError", {
  message: Schema.String,
}) {}

/** A webhook delivery was refused before any work: bad signature, malformed headers, or an installation that is not allowed. */
export class WebhookRejected extends Schema.TaggedError<
  WebhookRejected,
  { readonly brand: unique symbol }
>()("WebhookRejected", {
  reason: Schema.Literals([
    "missing-signature",
    "bad-signature",
    "malformed",
    "not-allowed",
  ]),
}) {}

/** The npm registry could not be read (the report retries on a bounded schedule). */
export class RegistryError extends Schema.TaggedError<
  RegistryError,
  { readonly brand: unique symbol }
>()("RegistryError", {
  message: Schema.String,
}) {}
