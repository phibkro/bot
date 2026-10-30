import { principalName } from "@bot/rules";
import { Bot, ReleaseLedger } from "@bot/service";
import type { Hint, WebhookVerifier } from "@bot/service";
import { DurableObject } from "cloudflare:workers";
import type { Config } from "effect";
import { Clock, Effect, Layer, ManagedRuntime } from "effect";

import { handleWebhook, Principal, PrincipalUnavailable } from "./ingress.ts";
import { botLayer, ingressLayer } from "./layers.ts";
import type { Bindings } from "./layers.ts";

/**
 * The Cloudflare host (spec 0000, D9, D11, Revisions 5): a Worker that verifies and routes webhooks, and one SQLite-backed
 * Durable Object per principal that holds the ledger and runs the bot. Both are thin: the only code here is the bridge from
 * the platform's Promise ABI (`fetch`, an RPC method, `alarm`) to one `ManagedRuntime` per host. The object is a plain
 * `DurableObject` class, so that PiHarness (spec 0001) can later be mounted on it with `Lifecycle.install(this)`.
 *
 * EX-0001 (`tools/quality/exceptions.json`): each `oxlint-disable-next-line` below is one of its sites, and the file's
 * `@effect-diagnostics asyncFunction:off`. The Workers ABI is Promise-based, so those four methods are `async`, and each one
 * builds or runs one `ManagedRuntime`.
 */

/** The bindings of the Worker: the object's namespace, two variables and two secrets (names only; values are set out of band). */
export interface Env extends Bindings {
  readonly RELEASE_BOT: DurableObjectNamespace<ReleaseBot>;
}

interface Delivery {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string;
  readonly hint: Hint;
}

/** One minute: when an alarm's run fails outright, the object wakes again. An alarm that throws stops retrying after 6 failures. */
const alarmRetryMs = 60_000;

type BotRuntime = ManagedRuntime.ManagedRuntime<Bot | ReleaseLedger, unknown>;

// @effect-diagnostics asyncFunction:off
export class ReleaseBot extends DurableObject<Env> {
  readonly #runtime: BotRuntime;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // oxlint-disable-next-line effect/no-premature-execution
    this.#runtime = ManagedRuntime.make(botLayer(env, ctx.storage));
  }

  /** The delivery is admitted (committed) before this returns: the output gate holds the answer until the write is stored. */
  // oxlint-disable-next-line effect/no-native-promise-control-flow
  async deliver(input: Delivery): Promise<"admitted" | "duplicate"> {
    const result = await this.#runtime.runPromise(
      Bot.use((bot) => bot.deliver(input))
    );

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(
        await this.#runtime.runPromise(Clock.currentTimeMillis)
      );
    }

    return result;
  }

  /** At-least-once; the bot never throws out of its alarm (it re-schedules failed items), and a failure here re-arms it. */
  // oxlint-disable-next-line effect/no-native-promise-control-flow
  override async alarm(): Promise<void> {
    try {
      const next = await this.#runtime.runPromise(Bot.use((bot) => bot.alarm));

      if (next !== undefined) {
        await this.ctx.storage.setAlarm(
          Math.max(
            next,
            (await this.#runtime.runPromise(Clock.currentTimeMillis)) + 1
          )
        );
      }
    } catch (error) {
      await this.#runtime.runPromise(
        Effect.logError("alarm failed", String(error))
      );
      await this.ctx.storage.setAlarm(
        (await this.#runtime.runPromise(Clock.currentTimeMillis)) + alarmRetryMs
      );
    }
  }

  /**
   * Read-only diagnostics, reachable only through the object's binding (the Worker forwards nothing to it): `GET /audit` answers
   * the audit log, oldest first. The local workerd smoke test and the operator read the bot's decisions through it.
   */
  // oxlint-disable-next-line effect/no-native-promise-control-flow
  override async fetch(request: Request): Promise<Response> {
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/audit"
    ) {
      return Response.json(
        await this.#runtime.runPromise(
          ReleaseLedger.use((ledger) => ledger.auditEntries)
        )
      );
    }

    return new Response("not found", { status: 404 });
  }
}

type IngressRuntime = ManagedRuntime.ManagedRuntime<
  Principal | WebhookVerifier,
  Config.ConfigError
>;

/** One ingress runtime per `env` object (the platform passes the same one for the life of an isolate). */
const ingressRuntimes = new WeakMap<Env, IngressRuntime>();

const ingressFor = (env: Env) => {
  const existing = ingressRuntimes.get(env);

  if (existing !== undefined) {
    return existing;
  }

  // oxlint-disable-next-line effect/no-premature-execution
  const created = ManagedRuntime.make(
    Layer.mergeAll(
      ingressLayer(env),
      Layer.succeed(
        Principal,
        Principal.of({
          deliver: (input) =>
            Effect.tryPromise({
              catch: (cause) =>
                new PrincipalUnavailable({ message: String(cause) }),
              try: () =>
                env.RELEASE_BOT.getByName(principalName).deliver(input),
            }),
        })
      )
    )
  );

  ingressRuntimes.set(env, created);

  return created;
};

export default {
  // oxlint-disable-next-line effect/no-native-promise-control-flow
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const answer = await ingressFor(env).runPromise(
      handleWebhook({
        body: new Uint8Array(await request.arrayBuffer()),
        deliveryId: request.headers.get("x-github-delivery"),
        event: request.headers.get("x-github-event"),
        method: request.method,
        path: url.pathname,
        signature: request.headers.get("x-hub-signature-256"),
      })
    );

    return new Response(answer.body, { status: answer.status });
  },
};
