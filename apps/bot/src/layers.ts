import {
  AppSettings,
  Bot,
  GitHubApi,
  GitHubApp,
  Narrator,
  Notifier,
  NpmRegistry,
  ReleaseLedger,
  WebhookVerifier,
} from "@bot/service";
import { SqliteClient } from "@effect/sql-sqlite-do";
import { ConfigProvider, Layer } from "effect";
import { Digest } from "effect/crypto";
import { FetchHttpClient } from "effect/http";

/**
 * The composition roots of the two hosts (spec 0000, D11): the Worker builds the ingress layer, the Durable Object builds the
 * bot layer. Each is built once per isolate and object, from the Worker's `env` (secrets and variables through `Config`,
 * never `process.env`) and, for the object, its SQLite storage. No service method runs an effect; the only runtime bridges
 * are in `worker.ts`.
 */

/** The Durable Object's storage as the SQL driver wants it: the full storage handle, for transactions. */
export interface ObjectStorage {
  readonly storage: Parameters<typeof SqliteClient.layer>[0]["storage"];
}

/** The names the bot reads from the Worker's environment (`secretNames` and `variableNames` of `@bot/rules`); values come from the platform. */
export interface Bindings {
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_CLIENT_ID: string;
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
}

export const ingressLayer = (env: Bindings) =>
  WebhookVerifier.layer.pipe(
    Layer.provide(AppSettings.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
  );

export const botLayer = (env: Bindings, storage: ObjectStorage["storage"]) => {
  const settings = AppSettings.layer.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env)))
  );

  const leaf = Layer.mergeAll(
    FetchHttpClient.layer,
    Digest.layerWebCrypto,
    SqliteClient.layer({ storage }),
    settings,
    Narrator.none
  );

  const app = GitHubApp.layer.pipe(Layer.provideMerge(leaf));

  const services = Layer.mergeAll(
    GitHubApi.layer,
    NpmRegistry.layer,
    ReleaseLedger.layer
  ).pipe(Layer.provideMerge(app));

  const notifier = Notifier.layer.pipe(Layer.provideMerge(services));

  return Bot.layer.pipe(Layer.provideMerge(notifier));
};
