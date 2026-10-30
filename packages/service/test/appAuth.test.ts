import { operatorAccount } from "@bot/rules";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Result } from "effect";
import { Digest, KeyFormat, SecureRandom, Signature } from "effect/crypto";
import { Base64, Base64Url } from "effect/encoding";

import { AppSettings, GitHubApp } from "../src/index.ts";
import { fakeHttp } from "./httpFake.ts";
import type { FakeReply, RecordedRequest } from "./httpFake.ts";

/**
 * F12 and the App identity (spec 0000, D10): the JWT is RS256 over `header.payload` with the App's key, the key imports from
 * GitHub's PKCS#1 PEM (and from PKCS#8), tokens are narrowed to one repository, and nothing secret is logged or thrown.
 * The key is generated for each run with `effect/crypto`; no key is stored in the repository.
 */

const algorithm = Signature.rsaPkcs1v15({
  hash: Digest.sha256,
  modulusLength: 2048,
});

/** RSA PKCS#8 wraps the PKCS#1 key in an OCTET STRING after the algorithm identifier: extract it, to build GitHub's PEM form. */
const pkcs1FromPkcs8 = (der: Uint8Array): Uint8Array => {
  const rsaIdentifier = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ];

  const at = der.findIndex((_, index) =>
    rsaIdentifier.every((byte, offset) => der[index + offset] === byte)
  );

  let cursor = at + rsaIdentifier.length;
  assert.strictEqual(der[cursor], 0x04);
  cursor += 1;
  const first = der[cursor] ?? 0;
  let length = first;
  cursor += 1;

  if (first === 0x82) {
    length = ((der[cursor] ?? 0) << 8) | (der[cursor + 1] ?? 0);
    cursor += 2;
  } else if (first === 0x81) {
    length = der[cursor] ?? 0;
    cursor += 1;
  }

  return der.slice(cursor, cursor + length);
};

const pem = (label: string, der: Uint8Array): string => {
  const lines = Base64.encode(der).match(/.{1,64}/gu) ?? [];

  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
};

const crypto = Layer.mergeAll(
  Signature.layerWebCrypto,
  Digest.layerWebCrypto
).pipe(Layer.provide(SecureRandom.layerWebCrypto));

const decoder = new TextDecoder();

const keyMaterial = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* signature.generateKeyPair(algorithm);
  const der = yield* KeyFormat.encode(KeyFormat.pkcs8, pair.privateKey);

  return {
    pair,
    pkcs1: pem("RSA PRIVATE KEY", pkcs1FromPkcs8(der)),
    pkcs8: pem("PRIVATE KEY", der),
    signature,
  };
});

const settingsLayer = (privateKey: string) =>
  Layer.succeed(
    AppSettings,
    AppSettings.of({
      appId: "123",
      clientId: "Iv1.testclient",
      privateKey: Redacted.make(privateKey),
      webhookSecret: Redacted.make("unused"),
    })
  );

const answerOf =
  (requests: RecordedRequest[]) =>
  (request: RecordedRequest): FakeReply => {
    requests.push(request);

    return request.method === "GET"
      ? {
          body: [
            { account: { id: operatorAccount.id }, id: 5, suspended_at: null },
          ],
          status: 200,
        }
      : {
          body: { expires_at: "2026-10-30T13:00:00Z", token: "ghs_minted" },
          status: 201,
        };
  };

describe("GitHubApp", () => {
  for (const form of ["pkcs1", "pkcs8"] as const) {
    it.effect(
      `signs an RS256 JWT with a ${form.toUpperCase()} key that GitHub can verify, and narrows the token to one repository`,
      () =>
        Effect.gen(function* () {
          const keys = yield* keyMaterial;
          const seen: RecordedRequest[] = [];
          const http = fakeHttp(answerOf(seen));

          const layer = GitHubApp.layer.pipe(
            Layer.provide(settingsLayer(keys[form])),
            Layer.provide(http.layer),
            Layer.provide(crypto)
          );

          const token = yield* GitHubApp.use((app) =>
            app.token({
              account: operatorAccount,
              permissions: { contents: "write", metadata: "read" },
              repository: "phibkro/pg-txmode",
            })
          ).pipe(Effect.provide(layer));

          assert.strictEqual(Redacted.value(token), "ghs_minted");

          const [list, mint] = seen;
          assert.strictEqual(
            list?.url,
            "https://api.github.com/app/installations"
          );
          const bearer = list?.headers.authorization ?? "";

          const [header = "", payload = "", sig = ""] = bearer
            .replace("Bearer ", "")
            .split(".");

          assert.strictEqual(
            decoder.decode(Result.getOrThrow(Base64Url.decode(header))),
            '{"alg":"RS256","typ":"JWT"}'
          );

          const claims = decoder.decode(
            Result.getOrThrow(Base64Url.decode(payload))
          );

          assert.include(claims, '"iss":"Iv1.testclient"');
          assert.include(claims, '"iat":-60');
          assert.include(claims, '"exp":540');

          const verified = yield* keys.signature.verify(
            yield* keys.signature.publicKeyOf(keys.pair.privateKey),
            Result.getOrThrow(Base64Url.decode(sig)),
            new TextEncoder().encode(`${header}.${payload}`)
          );

          assert.isTrue(verified);

          assert.strictEqual(mint?.method, "POST");
          assert.strictEqual(
            mint?.url,
            "https://api.github.com/app/installations/5/access_tokens"
          );
          assert.strictEqual(
            mint?.body,
            '{"permissions":{"contents":"write","metadata":"read"},"repositories":["pg-txmode"]}'
          );
        }).pipe(Effect.provide(crypto))
    );
  }

  it.effect(
    "a read token is cached for ten minutes; a write token is minted for each use",
    () =>
      Effect.gen(function* () {
        const keys = yield* keyMaterial;
        const seen: RecordedRequest[] = [];
        const http = fakeHttp(answerOf(seen));

        const layer = GitHubApp.layer.pipe(
          Layer.provide(settingsLayer(keys.pkcs1)),
          Layer.provide(http.layer),
          Layer.provide(crypto)
        );

        yield* Effect.gen(function* () {
          const app = yield* GitHubApp;

          const read = {
            account: operatorAccount,
            permissions: { metadata: "read", pull_requests: "read" } as const,
            repository: "phibkro/pg-txmode",
          };

          const write = {
            account: operatorAccount,
            permissions: { contents: "write" } as const,
            repository: "phibkro/pg-txmode",
          };

          yield* app.token(read);
          yield* app.token(read);
          yield* app.token(write);
          yield* app.token(write);
        }).pipe(Effect.provide(layer));
        assert.strictEqual(
          seen.filter((request) => request.method === "POST").length,
          3
        );
      }).pipe(Effect.provide(crypto))
  );

  it.effect(
    "no installation for the account is a typed AppAuthError, and the private key never appears in it",
    () =>
      Effect.gen(function* () {
        const keys = yield* keyMaterial;
        const http = fakeHttp(() => ({ body: [], status: 200 }));

        const layer = GitHubApp.layer.pipe(
          Layer.provide(settingsLayer(keys.pkcs1)),
          Layer.provide(http.layer),
          Layer.provide(crypto)
        );

        const error = yield* GitHubApp.use((app) =>
          app.token({
            account: operatorAccount,
            permissions: { metadata: "read" },
            repository: "phibkro/pg-txmode",
          })
        ).pipe(Effect.provide(layer), Effect.flip);

        assert.strictEqual(error._tag, "AppAuthError");
        assert.notInclude(String(error), "PRIVATE KEY");
      }).pipe(Effect.provide(crypto))
  );

  it.effect(
    "a key that is not a private key fails with AppAuthError that does not echo it",
    () =>
      Effect.gen(function* () {
        const bad =
          "-----BEGIN RSA PRIVATE KEY-----\nbm90IGEga2V5\n-----END RSA PRIVATE KEY-----";

        const http = fakeHttp(() => ({ status: 200 }));

        const error = yield* Effect.scoped(
          Layer.build(
            GitHubApp.layer.pipe(
              Layer.provide(settingsLayer(bad)),
              Layer.provide(http.layer),
              Layer.provide(crypto)
            )
          )
        ).pipe(Effect.flip);

        assert.strictEqual(error._tag, "AppAuthError");
        assert.notInclude(String(error), "bm90IGEga2V5");
      })
  );
});
