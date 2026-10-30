import { githubApiVersion } from "@bot/rules";
import type { Account, PermissionLevel, PermissionName } from "@bot/rules";
import type { Schema } from "effect";
import { Clock, Context, Effect, Layer, Redacted, Ref } from "effect";
import { KeyFormat, SecureRandom, Signature } from "effect/crypto";
import { Base64Url } from "effect/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { AppSettings } from "../AppSettings.ts";
import { AppAuthError, DecodeFailure, GitHubError } from "../errors.ts";
import { encodeJson } from "../json.ts";
import { guardEgress } from "./egress.ts";
import { Installations, InstallationToken } from "./schemas.ts";

/** What a minted installation token may do: the least permission, on one repository (spec 0000, D10). */
export type TokenScope = Readonly<
  Partial<Record<PermissionName, PermissionLevel>>
>;

export interface TokenRequest {
  readonly account: Account;
  /** `owner/name`; the token is narrowed to this one repository. */
  readonly repository: string;
  readonly permissions: TokenScope;
}

const encoder = new TextEncoder();

/**
 * The GitHub App's own identity: signs the App JWT (RS256, `iat` 60 s in the past, `exp` 9 minutes ahead, `iss` the client id)
 * with the private key, finds the installation of an allowed account, and mints an installation token narrowed to one
 * repository and the permissions asked for. A token is never persisted; read tokens are cached in memory for ten minutes
 * and write tokens are minted for each use. The key is `Redacted` from the Worker's secret to the signing call.
 */
export class GitHubApp extends Context.Service<
  GitHubApp,
  {
    /** The installation ids of the allowed accounts, as `GET /app/installations` returns them (never taken from a payload). */
    readonly installationOf: (
      account: Account
    ) => Effect.Effect<
      number | undefined,
      AppAuthError | GitHubError | DecodeFailure
    >;
    readonly token: (
      request: TokenRequest
    ) => Effect.Effect<
      Redacted.Redacted,
      AppAuthError | GitHubError | DecodeFailure
    >;
  }
>()("bot/github/GitHubApp") {
  static readonly layer = Layer.effect(
    GitHubApp,
    Effect.gen(function* () {
      const settings = yield* AppSettings;
      const signature = yield* Signature.Signature;
      const http = guardEgress(yield* HttpClient.HttpClient);
      const pem = Redacted.value(settings.privateKey);

      const privateKey = yield* KeyFormat.decodePrivate(
        pem.includes("BEGIN RSA PRIVATE KEY")
          ? KeyFormat.pem(KeyFormat.pkcs1)
          : KeyFormat.pem(KeyFormat.pkcs8),
        Signature.rsaPkcs1v15Sha256,
        pem
      ).pipe(
        Effect.mapError(
          () =>
            new AppAuthError({ message: "the App private key did not import" })
        )
      );

      const cache = yield* Ref.make<
        ReadonlyMap<
          string,
          { readonly token: Redacted.Redacted; readonly until: number }
        >
      >(new Map());

      const appJwt = Effect.gen(function* () {
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);

        const header = Base64Url.encode(
          yield* encodeJson({ alg: "RS256", typ: "JWT" })
        );

        const payload = Base64Url.encode(
          yield* encodeJson({
            exp: nowSeconds + 540,
            iat: nowSeconds - 60,
            iss: settings.clientId,
          })
        );

        const signed = yield* signature
          .sign(privateKey, encoder.encode(`${header}.${payload}`))
          .pipe(
            Effect.mapError(
              () =>
                new AppAuthError({ message: "the App JWT could not be signed" })
            )
          );

        return `${header}.${payload}.${Base64Url.encode(signed)}`;
      });

      const call = <A>(
        operation: string,
        schema: Schema.Decoder<A>,
        request: HttpClientRequest.HttpClientRequest
      ) =>
        Effect.gen(function* () {
          const jwt = yield* appJwt;

          const response = yield* http
            .execute(
              request.pipe(
                HttpClientRequest.bearerToken(jwt),
                HttpClientRequest.setHeaders({
                  accept: "application/vnd.github+json",
                  "user-agent": "phibkro-release-bot",
                  "x-github-api-version": githubApiVersion,
                })
              )
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new GitHubError({ message: String(cause), operation })
              )
            );

          if (response.status < 200 || response.status >= 300) {
            return yield* new GitHubError({
              message: `status ${response.status}`,
              operation,
              status: response.status,
            });
          }

          return yield* HttpClientResponse.schemaBodyJson(schema)(
            response
          ).pipe(
            Effect.mapError(
              (cause) =>
                new DecodeFailure({ message: String(cause), operation })
            )
          );
        });

      const installationOf = Effect.fn("GitHubApp.installationOf")(function* (
        account: Account
      ) {
        const installations = yield* call(
          "listInstallations",
          Installations,
          HttpClientRequest.get("https://api.github.com/app/installations")
        );

        return installations.find(
          (entry) =>
            entry.account?.id === account.id &&
            (entry.suspended_at ?? null) === null
        )?.id;
      });

      const token = Effect.fn("GitHubApp.token")(function* (
        request: TokenRequest
      ) {
        const key = `${request.repository}|${Object.entries(request.permissions)
          .map(([name, level]) => `${name}:${level}`)
          .toSorted()
          .join(",")}`;

        const now = yield* Clock.currentTimeMillis;

        const readOnly = Object.values(request.permissions).every(
          (level) => level === "read"
        );

        const cached = readOnly ? (yield* Ref.get(cache)).get(key) : undefined;

        if (cached !== undefined && cached.until > now) {
          return cached.token;
        }

        const installation = yield* installationOf(request.account);

        if (installation === undefined) {
          return yield* new AppAuthError({
            message: `no active installation for account ${request.account.login}`,
          });
        }

        const [, name = ""] = request.repository.split("/");

        const minted = yield* call(
          "createInstallationToken",
          InstallationToken,
          HttpClientRequest.post(
            `https://api.github.com/app/installations/${installation}/access_tokens`
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              permissions: request.permissions,
              repositories: [name],
            })
          )
        );

        const value = Redacted.make(minted.token);

        if (readOnly) {
          yield* Ref.update(cache, (entries) =>
            new Map(entries).set(key, {
              token: value,
              until: now + 10 * 60 * 1000,
            })
          );
        }

        return value;
      });

      return GitHubApp.of({ installationOf, token });
    })
  ).pipe(
    Layer.provide(Signature.layerWebCrypto),
    Layer.provide(SecureRandom.layerWebCrypto)
  );
}
