---
name: effect-house
description: "The bot repository's Effect overlay: its constructs, its two composition roots, the lint and diagnostic configuration, the exception registry and the checks. Use before writing or reviewing TypeScript in this repository."
---

# Effect house: bot

Read `/srv/share/projects/AGENTS.md` ("Effect-first"), then the installed guidance (`packages/service/node_modules/effect/AGENTS.md` and the `ai-docs/src` examples it links; Effect `4.1.0` here), then this file. The decision ladder and the exception lifecycle are the projects tier's; this file names what is specific to this repository.

## Layers of the code (libraries, services, platform integrations)

```text
packages/rules     pure library: no Effect, no dependencies. decideMerge, decideDispatch, parseRecord, renderComment,
                   the five repositories and their pins, the App's permissions/events/secret names, the checklist text
packages/service   services over abstract capabilities: HttpClient, SqlClient, Clock, Digest, Mac, ConfigProvider.
                   GitHubApp (RS256 JWT, tokens), GitHubApi (the only GitHub operations), ReleaseLedger (SQLite),
                   WebhookVerifier, NpmRegistry, Notifier, Narrator, Bot (deliver, alarm)
apps/bot           platform integration: the Worker, the Durable Object class, the layers, the Alchemy stack
```

Dependencies point down only (`apps → service → rules`). `@bot/*` imports go through the package export map (a lint rule).

## Constructs

| Need | Construct | Where |
| --- | --- | --- |
| A capability with a lifetime | `Context.Service` + a `layer` | `GitHubApp`, `GitHubApi`, `ReleaseLedger`, `WebhookVerifier`, `NpmRegistry`, `Notifier`, `Narrator` |
| Configuration | `Config` + `Redacted` through `ConfigProvider.fromUnknown(env)`; the Worker's `env` is the only source | `AppSettings`, `layers.ts` |
| A closed set of failures | `Schema.TaggedError` (branded) | `errors.ts` |
| A response or a payload | `Schema`, decoded at the boundary that owns it; an unknown field is dropped, a missing one is a `DecodeFailure` | `github/schemas.ts`, `webhook.ts` |
| Time | `Clock`; never `Date.now` | `Bot.ts`, `GitHubApp.ts` |
| Hashes, MACs, signatures | `effect/crypto` (`Digest`, `Mac`, `Signature`, `KeyFormat`); never `node:crypto` | `WebhookVerifier.ts`, `GitHubApp.ts`, `Bot.ts` |
| Egress | `guardEgress` wraps the `HttpClient`: a request that is not in the declared table of operations is refused (F6) | `github/egress.ts` |
| A narration of a report (spec 0001) | `Narrator`, with a `none` layer today | `Narrator.ts` |
| A total deterministic decision | a plain function | `packages/rules` |

Two writes are the load-bearing ones: **intent before effect** (`ReleaseLedger.claimAction` before a merge or a dispatch, `recordReceipt` after; `recordMerge` writes a merge's receipt and its release lock in one transaction) and **webhooks are hints** (a delivery marks an item dirty; the evaluation re-reads GitHub). The `act` gate is in `mergeIt` and `dispatchIt`, where the write happens, as well as in the verdict. Durability: the ledger is SQLite in the Durable Object, committed before the delivery is answered; an alarm is delivered at least once, so every write is idempotent by its key.

## Composition roots

Exactly two, both in `apps/bot/src/worker.ts`, each one `ManagedRuntime`:

- the Worker's **ingress** runtime (`ingressLayer`): verify the signature, decode the envelope, apply the allowlist, route to the object;
- the Durable Object's **bot** runtime (`botLayer(env, storage)`): the full service graph over the object's SQLite storage.

The Worker's `fetch`, the object's `deliver`, `alarm` and `fetch` are `async` because the Workers ABI is Promise-based (**EX-0001**, `tools/quality/exceptions.json`): the file-level `@effect-diagnostics asyncFunction:off` and one `oxlint-disable-next-line` per site (`effect/no-native-promise-control-flow` on the four methods, `effect/no-premature-execution` on the two `ManagedRuntime.make` calls). The Worker's ingress runtime is built once per `env` (the platform passes `env` to `fetch`; no global `Cloudflare.Env` augmentation). Each method body is one `runtime.runPromise` of an Effect. No other module runs an effect.

## Diagnostics and lint

- `bun run check:effect` runs `effect-tsgo tsc` (`@effect/tsgo`) on `packages/service` and `apps/bot` (tests included) with the language-service plugin from each `tsconfig.json`. `packages/rules` has no Effect, so it is checked by the same compiler without the plugin.
- `preferEffectArray`, `preferEffectString` and `preferEffectRecord` are **off**: they ask for `Array`/`String`/`Record` module calls on plain-data code (splitting a header, filtering a list of rows), where the native method is shorter and the lint rules (`ts-set-map`, `no-array-filter-map`, ...) already govern it. Every other severity is the plugin's default.
- `bun run check` is Vite+ (`vp check`: Oxfmt, Oxlint with `ultracite` core and anti-slop, `@phibkro/oxlint-effect-plugin`, `oxlint-plugin-complexity`). The relaxations are in the root `vite.config.ts`, each with its reason beside it. A relaxation that is a design choice (`complexity` cognitive 45 for the orchestration in `Bot.ts`) is named there; it is not a registered exception, because it is a rule's threshold, not a suppression.
- **A suppression directive** (`oxlint-disable`, `eslint-disable`, `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `@effect-diagnostics`) needs an entry in `tools/quality/exceptions.json` for that file and directive, and every entry needs a live directive (`bun run check:exceptions`). Today: EX-0001.
- Autofix hazard: `vp check --fix` rewrote `Effect.as(undefined)` to `Effect.as()` and a `ReadonlySet` annotation; `unicorn/no-useless-undefined` is off for that reason. After `--fix`, run `check:effect`.

## The checks, in order

```sh
devenv shell -- bun run ready   # check, check:effect, check:exceptions, check:docs, test, build, secrets
```

`test` runs the three packages: `@bot/rules` (the contract table against the real `merge.sh`), `@bot/service` (real SQLite through `@effect/sql-sqlite-bun`, so it runs under `bunx --bun vp test`) and `@bot/app` (the Worker's ingress, and the workerd smoke in `apps/bot/smoke`). `secrets` scans the commits with gitleaks.

## Installed guidance that had no entry (Effect 4.1.0)

Checked by `grep` over `node_modules/effect/ai-docs`: it has no example for `effect/crypto` (`Mac`, `Signature`, `KeyFormat`, `Digest`) or for `@effect/sql-sqlite-do`; `ManagedRuntime` has one (`04_integration/10_managed-runtime.ts`). The crypto and SQL APIs were read from `node_modules/effect/src` and the package sources, and each is covered by a test that fails when the behaviour changes (`appAuth.test.ts` for the JWT, `webhookRegistry.test.ts` for the MAC, the smoke for the Durable Object's SQLite).
