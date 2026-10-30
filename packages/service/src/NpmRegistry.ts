import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient } from "effect/http";

import { RegistryError } from "./errors.ts";
import { NpmVersionDoc } from "./github/schemas.ts";

/**
 * Public reads of the npm registry, no credentials (spec 0000, "The report"). The version document says who published a version:
 * the report reads `_npmUser`, because npm logs the OIDC outcome only at `verbose` level and provenance does not discriminate.
 */
export class NpmRegistry extends Context.Service<
  NpmRegistry,
  {
    /** The version document, or `undefined` when the registry has no such version (404). */
    readonly versionDoc: (
      name: string,
      version: string
    ) => Effect.Effect<typeof NpmVersionDoc.Type | undefined, RegistryError>;
  }
>()("bot/NpmRegistry") {
  static readonly layer = Layer.effect(
    NpmRegistry,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      const versionDoc = Effect.fn("NpmRegistry.versionDoc")(function* (
        name: string,
        version: string
      ) {
        // A scoped name travels as `@scope%2fname` in the registry's path.
        const response = yield* http
          .get(
            `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`
          )
          .pipe(
            Effect.mapError(
              (cause) => new RegistryError({ message: String(cause) })
            )
          );

        if (response.status === 404) {
          return;
        }

        if (response.status !== 200) {
          return yield* new RegistryError({
            message: `status ${response.status}`,
          });
        }

        return yield* response.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(NpmVersionDoc)),
          Effect.mapError(
            (cause) => new RegistryError({ message: String(cause) })
          )
        );
      });

      return NpmRegistry.of({ versionDoc });
    })
  );
}
