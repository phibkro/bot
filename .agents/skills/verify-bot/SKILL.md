---
name: verify-bot
description: "Run and observe the release bot the way a reviewer does: the gates on a clean checkout, the contract table against the real merge.sh, the workerd smoke of the webhook path, the generated operator checklist, and what only the operator's live journey can show. Use when reviewing a bot PR, verifying a change, or before the operator's first deploy."
---

<!-- Provenance: new for bot, in the shape of phibkro/pg-txmode's `verify-pg-txmode` @ 23be53c0c66a129540350697253b5c19abde3171
     (gates, observe, path table, limits), much smaller: this bot has no throwaway database to start; its runtime is workerd. -->

# Verify bot

A reviewer uses this skill in a detached worktree of the PR head. Nothing here needs a credential, a network write, or the operator's accounts.

## 1. The gates

```sh
devenv shell -- bun install --frozen-lockfile
devenv shell -- bun run ready
```

`ready` is, in order: `check` (Oxfmt, Oxlint, type-aware lint), `check:effect` (`effect-tsgo` diagnostics on the service and the app), `check:exceptions` (every suppression registered), `check:docs` (the operator checklist equals its generator), `test` (all three packages, including the smoke), `build` (the Worker bundle), `secrets` (gitleaks over the commits). It must exit 0 on the head.

## 2. The contract: `decideMerge` against the real `merge.sh`

```sh
cd packages/rules && devenv shell -- bunx vp test contract
```

The table in `test/contractTable.ts` (M01 to M20, X01 to X12) is run through the repository's own `merge.sh` in a throwaway git repository with a stub `gh`, and through `decideMerge`; the two must agree row by row. A rule the table does not cover is not verified. Negative control: in `packages/rules/src/merge.ts`, drop `NEUTRAL` from `greenConclusions`; M10 must fail.

## 3. The runtime: the webhook path in workerd

```sh
devenv shell -- bun run smoke
```

Bundles the Worker as it deploys, starts it in local workerd (Miniflare, SQLite-backed Durable Object, alarms), signs deliveries with a key and a secret generated for the run, and serves GitHub from the captured fixtures. It asserts a bad signature is 401, a stranger's account is dropped before the object, a delivery is admitted once and a repeat is `duplicate`, the alarm reads the pull request and writes a `merge-verdict` audit row, and in observe mode the fake GitHub saw no write (the token mint is the one POST). Negative controls: in `apps/bot/src/ingress.ts`, drop the allowlist check (F15 fails in `test/ingress.test.ts` and in the smoke); in `packages/service/src/github/GitHubApi.ts`, drop `sha: request.sha` from the merge request (F2 fails in `githubApi.test.ts`).

## 4. The operator checklist

`docs/operator-checklist.md` is generated (`bun run docs:gen`) from `packages/rules/src/app.ts` and `config.ts`: the permissions, events, secret names and installs cannot differ from what the code enforces. Read it as the operator would: it names no value, only names and lengths.

## 5. What only the live journey shows

Not runnable headless, so never reported as verified here: the App's real installation tokens and permission errors, the real merge API's `mergeable` against `git merge-tree`, Cloudflare's behaviour on deploy (that a deploy keeps out-of-band secrets), Alchemy's acceptance of `apps/bot/alchemy.run.ts` (type-checked, never deployed), and the operator's own click on "Review deployments". They are falsifier F19 and F20 of spec 0000, run by the operator on a throwaway repository with the checklist.

## Path table

| Changed paths | Run besides `ready` |
| --- | --- |
| `docs/**`, `*.md`, `.agents/**` only | nothing: they drive no code. Say so |
| `packages/rules/**` | section 2 and a negative control for the changed rule |
| `packages/service/src/github/**` | `bunx --bun vp test` in `packages/service`; check that every operation is in `egress.ts` and its permission in `app.ts` (F6) |
| `apps/bot/**` | section 3 |
| `tools/quality/**` | `check:exceptions` with a directive added and not registered; it must fail |
