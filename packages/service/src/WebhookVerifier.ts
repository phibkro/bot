import { Context, Effect, Layer, Redacted } from "effect";
import { Mac, SecureRandom } from "effect/crypto";

import { AppSettings } from "./AppSettings.ts";
import { WebhookRejected } from "./errors.ts";

/**
 * Webhook signature verification (spec 0000, D10): HMAC-SHA256 over the **raw request bytes** with `effect/crypto`'s `Mac`,
 * compared in constant time (`Mac.verify`). The header is `X-Hub-Signature-256: sha256=<hex>`. No `node:crypto`.
 */
export class WebhookVerifier extends Context.Service<
  WebhookVerifier,
  {
    readonly verify: (input: {
      readonly signatureHeader: string | null;
      readonly body: Uint8Array;
    }) => Effect.Effect<void, WebhookRejected>;
  }
>()("bot/WebhookVerifier") {
  static readonly layer = Layer.effect(
    WebhookVerifier,
    Effect.gen(function* () {
      const settings = yield* AppSettings;
      const mac = yield* Mac.Mac;

      const key = yield* Mac.key(
        Mac.hmacSha256,
        new TextEncoder().encode(Redacted.value(settings.webhookSecret))
      ).pipe(Effect.orDie);

      const verify = Effect.fn("WebhookVerifier.verify")(function* (input: {
        readonly signatureHeader: string | null;
        readonly body: Uint8Array;
      }) {
        const header = input.signatureHeader;

        if (header === null || header === "") {
          return yield* new WebhookRejected({ reason: "missing-signature" });
        }

        const tag = decodeSignature(header);

        if (tag === undefined) {
          return yield* new WebhookRejected({ reason: "malformed" });
        }

        const valid = yield* mac
          .verify(key, tag, input.body)
          .pipe(Effect.orDie);

        if (!valid) {
          return yield* new WebhookRejected({ reason: "bad-signature" });
        }
      });

      return WebhookVerifier.of({ verify });
    })
  ).pipe(
    Layer.provide(Mac.layerWebCrypto),
    Layer.provide(SecureRandom.layerWebCrypto)
  );
}

const hexPattern = /^[0-9a-f]{64}$/u;

/** `sha256=<64 hex>` to bytes; anything else is malformed. */
export const decodeSignature = (header: string): Uint8Array | undefined => {
  if (!header.startsWith("sha256=")) {
    return undefined;
  }

  const hex = header.slice("sha256=".length);

  if (!hexPattern.test(hex)) {
    return undefined;
  }

  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );
};
