import { AppSettings, WebhookVerifier } from "@bot/service";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import {
  handleWebhook,
  PrincipalUnavailable,
  Principal,
} from "../src/ingress.ts";
import type { IngressRequest } from "../src/ingress.ts";

/** F4, F5 and F15 (spec 0000) at the Worker: signature first, allowlist before the Durable Object, one delivery id once. */

const secret = "test-webhook-secret-value";
const encoder = new TextEncoder();

const verifier = WebhookVerifier.layer.pipe(
  Layer.provide(
    Layer.succeed(
      AppSettings,
      AppSettings.of({
        appId: "1",
        clientId: "c",
        privateKey: Redacted.make("unused"),
        webhookSecret: Redacted.make(secret),
      })
    )
  )
);

const sign = (text: string) =>
  Effect.gen(function* () {
    const mac = yield* Mac.Mac;
    const key = yield* Mac.key(Mac.hmacSha256, encoder.encode(secret));

    return `sha256=${Hex.encode(yield* mac.sign(key, encoder.encode(text)))}`;
  }).pipe(
    Effect.provide(
      Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
    )
  );

const reviewEvent = (ownerId: number) =>
  `{"action":"submitted","pull_request":{"number":7},"repository":{"full_name":"phibkro/pg-txmode","owner":{"id":${ownerId}}}}`;

interface FakePrincipal {
  readonly layer: Layer.Layer<Principal>;
  readonly seen: string[];
}

const principal = (
  answer: "admitted" | "duplicate" | "unavailable"
): FakePrincipal => {
  const seen: string[] = [];

  const layer = Layer.succeed(
    Principal,
    Principal.of({
      deliver: (input) => {
        seen.push(input.deliveryId);

        return answer === "unavailable"
          ? Effect.fail(new PrincipalUnavailable({ message: "down" }))
          : Effect.succeed(answer);
      },
    })
  );

  return { layer, seen };
};

const request = (
  body: string,
  signature: string | null,
  overrides: Partial<IngressRequest> = {}
): IngressRequest => ({
  body: encoder.encode(body),
  deliveryId: "delivery-1",
  event: "pull_request_review",
  method: "POST",
  path: "/webhook/github",
  signature,
  ...overrides,
});

const run = (req: IngressRequest, port: FakePrincipal) =>
  handleWebhook(req).pipe(Effect.provide(Layer.mergeAll(verifier, port.layer)));

describe("the webhook ingress", () => {
  it.effect(
    "F5: a missing, malformed or wrong signature is 401 or 400 and the object is never called",
    () =>
      Effect.gen(function* () {
        const port = principal("admitted");
        const body = reviewEvent(71_797_726);
        assert.strictEqual((yield* run(request(body, null), port)).status, 401);
        assert.strictEqual(
          (yield* run(request(body, "sha256=00"), port)).status,
          400
        );
        assert.strictEqual(
          (yield* run(request(body, `sha256=${"0".repeat(64)}`), port)).status,
          401
        );
        assert.strictEqual(
          (yield* run(request(body, yield* sign(`${body} `)), port)).status,
          401
        );
        assert.deepStrictEqual(port.seen, []);
      })
  );

  it.effect(
    "a signed delivery of an allowed account is admitted once; a redelivery is a 200 duplicate",
    () =>
      Effect.gen(function* () {
        const body = reviewEvent(71_797_726);
        const signature = yield* sign(body);
        const first = principal("admitted");
        const second = principal("duplicate");
        assert.deepStrictEqual(yield* run(request(body, signature), first), {
          body: "admitted",
          status: 202,
        });
        assert.deepStrictEqual(yield* run(request(body, signature), second), {
          body: "duplicate",
          status: 200,
        });
        assert.deepStrictEqual(first.seen, ["delivery-1"]);
      })
  );

  it.effect(
    "F15: a delivery from a stranger's installation is dropped before the object",
    () =>
      Effect.gen(function* () {
        const port = principal("admitted");
        const body = reviewEvent(12_345);
        assert.deepStrictEqual(
          yield* run(request(body, yield* sign(body)), port),
          { body: "ignored", status: 202 }
        );
        assert.deepStrictEqual(port.seen, []);
      })
  );

  it.effect("the organisation's account is allowed too", () =>
    Effect.gen(function* () {
      const port = principal("admitted");
      const body = reviewEvent(349_117_663);
      assert.strictEqual(
        (yield* run(request(body, yield* sign(body)), port)).status,
        202
      );
      assert.strictEqual(port.seen.length, 1);
    })
  );

  it.effect(
    "ping is answered, other paths and methods are refused, headers are required",
    () =>
      Effect.gen(function* () {
        const port = principal("admitted");
        const body = "{}";
        const signature = yield* sign(body);
        assert.deepStrictEqual(
          yield* run(request(body, signature, { event: "ping" }), port),
          { body: "pong", status: 200 }
        );
        assert.strictEqual(
          (yield* run(request(body, signature, { path: "/other" }), port))
            .status,
          404
        );
        assert.strictEqual(
          (yield* run(request(body, signature, { method: "GET" }), port))
            .status,
          405
        );
        assert.strictEqual(
          (yield* run(request(body, signature, { deliveryId: null }), port))
            .status,
          400
        );
        assert.strictEqual(
          (yield* run(request("not json", yield* sign("not json")), port))
            .status,
          400
        );
        assert.deepStrictEqual(port.seen, []);
      })
  );

  it.effect(
    "when the object is unreachable the answer is 503 (the sweep repairs the missed delivery)",
    () =>
      Effect.gen(function* () {
        const body = reviewEvent(71_797_726);
        assert.strictEqual(
          (yield* run(
            request(body, yield* sign(body)),
            principal("unavailable")
          )).status,
          503
        );
      })
  );
});
