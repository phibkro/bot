import { Config, Context, Effect, Layer } from "effect";
import type { Redacted } from "effect";

/**
 * The Worker's configuration (spec 0000, O3): two plain variables and two secrets, read through `Config` while the layer is
 * built. The secrets are `Redacted`: they never reach a log, an audit row or an error message. Names only are written down.
 */
export class AppSettings extends Context.Service<
  AppSettings,
  {
    readonly appId: string;
    readonly clientId: string;
    readonly privateKey: Redacted.Redacted;
    readonly webhookSecret: Redacted.Redacted;
  }
>()("bot/AppSettings") {
  static readonly layer = Layer.effect(
    AppSettings,
    Effect.gen(function* () {
      const appId = yield* Config.NonEmptyString("GITHUB_APP_ID");
      const clientId = yield* Config.NonEmptyString("GITHUB_APP_CLIENT_ID");
      const privateKey = yield* Config.Redacted("GITHUB_APP_PRIVATE_KEY");
      const webhookSecret = yield* Config.Redacted("GITHUB_WEBHOOK_SECRET");

      return AppSettings.of({ appId, clientId, privateKey, webhookSecret });
    })
  );
}
