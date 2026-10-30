// EX-0001 (tools/quality/exceptions.json): the Workers host ABI is Promise-based and its `env` is typed by a global interface.
// oxlint-disable effect/no-native-promise-control-flow, effect/no-premature-execution, typescript/no-empty-object-type, typescript/no-empty-interface, typescript/consistent-type-imports, typescript/no-namespace
import { principalName } from "@bot/rules";
import { Bot, ReleaseLedger } from "@bot/service";
import type { Hint } from "@bot/service";
import { DurableObject, env as workerEnv } from "cloudflare:workers";
import { Clock, Effect, Layer, ManagedRuntime } from "effect";

import { handleWebhook, Principal, PrincipalUnavailable } from "./ingress.ts";
import { botLayer, ingressLayer } from "./layers.ts";
import type { Bindings } from "./layers.ts";

/**
 * The Cloudflare host (spec 0000, D9, D11, Revisions 5): a Worker that verifies and routes webhooks, and one SQLite-backed
 * Durable Object per principal that holds the ledger and runs the bot. Both are thin: the only code here is the bridge from
 * the platform's Promise ABI (`fetch`, an RPC method, `alarm`) to one `ManagedRuntime` per host. The object is a plain
 * `DurableObject` class, so that PiHarness (spec 0001) can later be mounted on it with `Lifecycle.install(this)`.
 */

/** The bindings of the Worker: the object's namespace, two variables and two secrets (names only; values are set out of band). */
export interface Env extends Bindings {
  readonly RELEASE_BOT: DurableObjectNamespace<ReleaseBot>;
}

declare global {
  // `env` from `cloudflare:workers` is typed by this global interface: the Worker's own bindings join it here.
  namespace Cloudflare {
    interface Env extends Omit<import("./worker.ts").Env, never> {}
  }
}

interface Delivery {
  readonly deliveryId: string;
  readonly event: string;
  readonly action: string;
  readonly hint: Hint;
}

/** One minute: when an alarm's run fails outright, the object wakes again. An alarm that throws stops retrying after 6 failures. */
const alarmRetryMs = 60_000;

// @effect-diagnostics asyncFunction:off
export class ReleaseBot extends DurableObject<Env> {
  readonly #runtime: ManagedRuntime.ManagedRuntime<
    Bot | ReleaseLedger,
    unknown
  >;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#runtime = ManagedRuntime.make(botLayer(env, ctx.storage));
  }

  /** The delivery is admitted (committed) before this returns: the output gate holds the answer until the write is stored. */
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

const ingress = ManagedRuntime.make(
  Layer.mergeAll(
    ingressLayer(workerEnv),
    Layer.succeed(
      Principal,
      Principal.of({
        deliver: (input) =>
          Effect.tryPromise({
            catch: (cause) =>
              new PrincipalUnavailable({ message: String(cause) }),
            try: () =>
              workerEnv.RELEASE_BOT.getByName(principalName).deliver(input),
          }),
      })
    )
  )
);

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const answer = await ingress.runPromise(
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
