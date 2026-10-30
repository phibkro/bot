import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Config, Effect } from "effect";

import type { ReleaseBot } from "./src/worker.ts";

/**
 * The deploy definition (spec 0000, D9, D11, "Operator steps" 3): one Worker, one SQLite-backed Durable Object class. It declares
 * **no secret**: `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET` are put on the Worker out of band (the checklist, step 4),
 * so their values never enter Alchemy state. The App id and the client id are not secrets and are read at deploy time.
 * Nothing in this repository runs this file: deploying is the operator's step.
 */
export default Alchemy.Stack(
  "release-bot",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const appId = yield* Config.NonEmptyString("GITHUB_APP_ID");
    const clientId = yield* Config.NonEmptyString("GITHUB_APP_CLIENT_ID");

    const worker = yield* Cloudflare.Worker("ReleaseBot", {
      compatibility: { date: "2026-08-01", flags: ["nodejs_compat"] },
      env: {
        GITHUB_APP_CLIENT_ID: clientId,
        GITHUB_APP_ID: appId,
        RELEASE_BOT: Cloudflare.DurableObject<ReleaseBot>("ReleaseBot"),
      },
      main: "./src/worker.ts",
      observability: { enabled: true },
    });

    return { url: worker.url };
  })
);
