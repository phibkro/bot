import { classifyPublisher } from "@bot/rules";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import { Mac, SecureRandom } from "effect/crypto";
import { Hex } from "effect/encoding";

import {
  AppSettings,
  interpret,
  NpmRegistry,
  WebhookEnvelope,
  WebhookVerifier,
} from "../src/index.ts";
import alpha0 from "./fixtures/npm/core-0.1.0-alpha.0.json" with { type: "json" };
import alpha1 from "./fixtures/npm/core-0.1.0-alpha.1.json" with { type: "json" };
import alpha2 from "./fixtures/npm/core-0.1.0-alpha.2.json" with { type: "json" };
import { fakeHttp } from "./httpFake.ts";

/** F5 (the verifier) and F17 (the registry documents), spec 0000. */

const secret = "It's a Secret to Everybody";
const payload = "Hello, World!";

// GitHub's published test vector (docs, "Validating webhook deliveries").
const githubVector =
  "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

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

const verify = (signatureHeader: string | null, text: string) =>
  WebhookVerifier.use((v) =>
    v.verify({ body: new TextEncoder().encode(text), signatureHeader })
  ).pipe(Effect.provide(verifier), Effect.flip, Effect.option);

describe("WebhookVerifier (F5)", () => {
  it.effect("GitHub's own test vector verifies", () =>
    WebhookVerifier.use((v) =>
      v.verify({
        body: new TextEncoder().encode(payload),
        signatureHeader: githubVector,
      })
    ).pipe(Effect.provide(verifier))
  );

  it.effect(
    "a missing, malformed, wrong-length or wrong signature is rejected with its reason",
    () =>
      Effect.gen(function* () {
        const reason = (header: string | null, text = payload) =>
          verify(header, text).pipe(
            Effect.map((error) =>
              error._tag === "Some" ? error.value.reason : "accepted"
            )
          );

        assert.strictEqual(yield* reason(null), "missing-signature");
        assert.strictEqual(yield* reason(""), "missing-signature");
        assert.strictEqual(yield* reason("sha1=abc"), "malformed");
        assert.strictEqual(yield* reason("sha256=zz"), "malformed");
        assert.strictEqual(
          yield* reason(githubVector.slice(0, -2)),
          "malformed"
        );
        assert.strictEqual(
          yield* reason(githubVector.replace("757107", "757108")),
          "bad-signature"
        );
        assert.strictEqual(
          yield* reason(githubVector, "Hello, World! "),
          "bad-signature"
        );
      })
  );

  it.effect(
    "the signature is over the raw bytes: the same JSON with other whitespace does not verify",
    () =>
      Effect.gen(function* () {
        const mac = yield* Mac.Mac;

        const key = yield* Mac.key(
          Mac.hmacSha256,
          new TextEncoder().encode(secret)
        );

        const raw = '{"action":  "submitted"}';
        const tag = yield* mac.sign(key, new TextEncoder().encode(raw));
        const header = `sha256=${Hex.encode(tag)}`;
        assert.strictEqual((yield* verify(header, raw))._tag, "None");
        assert.strictEqual(
          (yield* verify(header, '{"action":"submitted"}'))._tag,
          "Some"
        );
      }).pipe(
        Effect.provide(
          Mac.layerWebCrypto.pipe(Layer.provide(SecureRandom.layerWebCrypto))
        )
      )
  );
});

describe("interpret", () => {
  const decode = Schema.decodeUnknownEffect(WebhookEnvelope);

  const repository = {
    full_name: "phibkro/pg-txmode",
    owner: { id: 71_797_726 },
  };

  it.effect("maps each subscribed event to a hint and the owning account", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        interpret(
          "pull_request_review",
          yield* decode({
            action: "submitted",
            pull_request: { number: 7 },
            repository,
          })
        ),
        {
          _tag: "Hint",
          accountId: 71_797_726,
          action: "submitted",
          hint: { _tag: "Pull", number: 7, repository: "phibkro/pg-txmode" },
        }
      );
      assert.strictEqual(
        interpret(
          "check_run",
          yield* decode({ check_run: { head_sha: "a".repeat(40) }, repository })
        )._tag,
        "Hint"
      );
      assert.strictEqual(
        interpret(
          "workflow_job",
          yield* decode({
            action: "waiting",
            repository,
            workflow_job: { run_id: 9 },
          })
        )._tag,
        "Hint"
      );
      assert.strictEqual(
        interpret(
          "installation",
          yield* decode({
            action: "suspend",
            installation: { account: { id: 5 }, id: 1 },
          })
        )._tag,
        "Hint"
      );
    })
  );

  it.effect(
    "ignores an unsubscribed event, a comment on a plain issue, and a payload without a repository",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          interpret("push", yield* decode({ repository }))._tag,
          "Ignored"
        );
        assert.strictEqual(
          interpret(
            "issue_comment",
            yield* decode({ issue: { number: 3 }, repository })
          )._tag,
          "Ignored"
        );
        assert.strictEqual(
          interpret("pull_request", yield* decode({ number: 3 }))._tag,
          "Ignored"
        );
      })
  );
});

describe("NpmRegistry and the captured documents (F17)", () => {
  const docs = new Map<string, object>([
    ["0.1.0-alpha.0", alpha0],
    ["0.1.0-alpha.1", alpha1],
    ["0.1.0-alpha.2", alpha2],
  ]);

  const http = fakeHttp((request) => {
    const version = decodeURIComponent(
      new URL(request.url).pathname.split("/").at(-1) ?? ""
    );

    const doc = docs.get(version);

    return doc === undefined ? { status: 404 } : { body: doc, status: 200 };
  });

  const registry = NpmRegistry.layer.pipe(Layer.provide(http.layer));

  it.effect(
    "alpha.2 is oidc, alpha.0 and alpha.1 are token, an absent version is not-published",
    () =>
      Effect.gen(function* () {
        const registryService = yield* NpmRegistry;

        const publisher = (version: string) =>
          registryService
            .versionDoc("@pg-txmode/core", version)
            .pipe(Effect.map(classifyPublisher));

        assert.strictEqual(yield* publisher("0.1.0-alpha.2"), "oidc");
        assert.strictEqual(yield* publisher("0.1.0-alpha.0"), "token");
        assert.strictEqual(yield* publisher("0.1.0-alpha.1"), "token");
        assert.strictEqual(yield* publisher("9.9.9"), "not-published");
        assert.isTrue(
          http.requests.every((request) =>
            request.url.startsWith(
              "https://registry.npmjs.org/@pg-txmode%2fcore/"
            )
          )
        );
      }).pipe(Effect.provide(registry))
  );

  it("the control: provenance does not tell the paths apart (all three carry an attestation)", () => {
    for (const doc of [alpha0, alpha1, alpha2]) {
      assert.strictEqual(
        doc.dist.attestations.provenance.predicateType,
        "https://slsa.dev/provenance/v1"
      );
    }
  });

  it.effect(
    "the committed fixtures hold no personal data: no e-mail but the trusted publisher's",
    () =>
      Effect.gen(function* () {
        for (const doc of [alpha0, alpha1, alpha2]) {
          const text = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Unknown)
          )(doc);

          for (const email of text.match(/[\w.+-]+@[\w.-]+\.[a-z]+/gu) ?? []) {
            assert.isTrue(
              email === "npm-oidc-no-reply@github.com" ||
                email === "redacted@example.invalid",
              email
            );
          }
        }
      })
  );
});
