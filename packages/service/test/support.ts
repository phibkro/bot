import { allowedAccounts, operatorIds } from "@bot/rules";
import type { RepositoryConfig } from "@bot/rules";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { Effect, Layer, Schema } from "effect";
import { Digest } from "effect/crypto";

import {
  Bot,
  BotConfig,
  Narrator,
  Notifier,
  NpmRegistry,
  ReleaseLedger,
  RegistryError,
} from "../src/index.ts";
import type { BotSettings } from "../src/index.ts";
import { fakeGitHub } from "./fakeGitHub.ts";
import type { World } from "./fakeGitHub.ts";
import alpha0 from "./fixtures/npm/core-0.1.0-alpha.0.json" with { type: "json" };
import alpha2 from "./fixtures/npm/core-0.1.0-alpha.2.json" with { type: "json" };

const NpmDoc = Schema.Struct({
  _npmUser: Schema.optional(
    Schema.Struct({ email: Schema.String, name: Schema.String })
  ),
  name: Schema.String,
  version: Schema.String,
});

/** The registry: the captured documents of `@pg-txmode/core` (spec 0000, F17); anything else is not published yet. */
const registryDocs = new Map<string, unknown>([
  ["@pg-txmode/core@0.1.0-alpha.0", alpha0],
  ["@pg-txmode/core@0.1.0-alpha.2", alpha2],
]);

export const fakeRegistry = Layer.succeed(
  NpmRegistry,
  NpmRegistry.of({
    versionDoc: Effect.fn("fakeRegistry.versionDoc")(function* (
      name: string,
      version: string
    ) {
      const doc = registryDocs.get(`${name}@${version}`);

      if (doc === undefined) {
        return undefined;
      }

      return yield* Schema.decodeUnknownEffect(NpmDoc)(doc).pipe(
        Effect.mapError(
          (cause) => new RegistryError({ message: String(cause) })
        )
      );
    }),
  })
);

/** The bot over a fake GitHub, the fake registry and a real SQLite ledger (`:memory:`), with the declared configuration narrowed to `repos`. */
export const botStack = (
  world: World,
  repos: readonly RepositoryConfig[],
  overrides: Partial<BotSettings> = {}
) => {
  const settings: BotSettings = {
    allowedAccounts,
    operatorIds,
    registryPatienceMs: 5 * 60 * 1000,
    repositories: repos,
    sweepIntervalMs: 10 * 60 * 1000,
    ...overrides,
  };

  const ledger = ReleaseLedger.layer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" }))
  );

  const base = Layer.mergeAll(
    fakeGitHub(world),
    ledger,
    fakeRegistry,
    Narrator.none,
    Digest.layerWebCrypto,
    Layer.succeed(BotConfig, settings)
  );

  const notifier = Notifier.layer.pipe(Layer.provideMerge(base));

  return Bot.layer.pipe(Layer.provideMerge(notifier));
};
