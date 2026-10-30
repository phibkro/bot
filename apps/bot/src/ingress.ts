import {
  BotConfig,
  interpret,
  WebhookEnvelope,
  WebhookVerifier,
} from "@bot/service";
import type { Hint } from "@bot/service";
import { Context, Effect, Schema } from "effect";

/**
 * The webhook path (spec 0000, D4, D10, F5, F15): signature first, over the raw bytes; then the envelope; then the account
 * allowlist; only then the Durable Object. Nothing unauthenticated, and nothing from a stranger's installation, reaches the object.
 */

export interface IngressRequest {
  readonly method: string;
  readonly path: string;
  readonly event: string | null;
  readonly deliveryId: string | null;
  readonly signature: string | null;
  readonly body: Uint8Array;
}

export interface IngressResponse {
  readonly status: number;
  readonly body: string;
}

/** The Durable Object of the principal, as the Worker sees it. */
export class Principal extends Context.Service<
  Principal,
  {
    readonly deliver: (input: {
      readonly deliveryId: string;
      readonly event: string;
      readonly action: string;
      readonly hint: Hint;
    }) => Effect.Effect<"admitted" | "duplicate", PrincipalUnavailable>;
  }
>()("bot/Principal") {}

/** The object could not be reached; the Worker answers 503 and the reconcile sweep repairs the missed delivery. */
export class PrincipalUnavailable extends Schema.TaggedError<
  PrincipalUnavailable,
  { readonly brand: unique symbol }
>()("PrincipalUnavailable", { message: Schema.String }) {}

const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WebhookEnvelope)
);

const decoder = new TextDecoder();

const reply = (status: number, body: string): IngressResponse => ({
  body,
  status,
});

export const webhookPath = "/webhook/github";

export const handleWebhook = Effect.fn("handleWebhook")(function* (
  request: IngressRequest
) {
  if (request.path !== webhookPath) {
    return reply(404, "not found");
  }

  if (request.method !== "POST") {
    return reply(405, "method not allowed");
  }

  const verifier = yield* WebhookVerifier;

  const rejection = yield* verifier
    .verify({ body: request.body, signatureHeader: request.signature })
    .pipe(
      Effect.as(undefined),
      Effect.catchTag("WebhookRejected", (rejected) =>
        Effect.succeed(rejected.reason)
      )
    );

  if (rejection !== undefined) {
    return reply(rejection === "malformed" ? 400 : 401, rejection);
  }

  if (
    request.event === null ||
    request.deliveryId === null ||
    request.deliveryId === ""
  ) {
    return reply(400, "missing event or delivery id headers");
  }

  if (request.event === "ping") {
    return reply(200, "pong");
  }

  const envelope = yield* decodeEnvelope(decoder.decode(request.body)).pipe(
    Effect.option
  );

  if (envelope._tag === "None") {
    return reply(400, "malformed payload");
  }

  const interpretation = interpret(request.event, envelope.value);
  const settings = yield* BotConfig;

  if (
    interpretation._tag === "Ignored" ||
    !settings.allowedAccounts.some(
      (account) => account.id === interpretation.accountId
    )
  ) {
    // A stranger's installation, an unsubscribed event: dropped before the Durable Object, no token is ever minted for it.
    return reply(202, "ignored");
  }

  const principal = yield* Principal;

  return yield* principal
    .deliver({
      action: interpretation.action,
      deliveryId: request.deliveryId,
      event: request.event,
      hint: interpretation.hint,
    })
    .pipe(
      Effect.map((result) =>
        result === "admitted" ? reply(202, "admitted") : reply(200, "duplicate")
      ),
      Effect.catchTag("PrincipalUnavailable", () =>
        Effect.succeed(reply(503, "unavailable"))
      )
    );
});
