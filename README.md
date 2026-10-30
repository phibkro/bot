# bot

A GitHub App that automates releases for the operator's repositories, hosted on the operator's Cloudflare account as a Durable Object. This repository is **private**: no secret, no personal data in files, logs or fixtures (names and lengths only).

```text
reviewed PR ── green CI ──▶ bot merges that exact head ──▶ (version PR) bot dispatches release.yml
            ──▶ bot comments the run URL: the operator clicks "Review deployments" (never the bot)
            ──▶ run ends ──▶ bot reports, per package, whether npm took the OIDC path or the token
```

**Authority:** merge (only when each repository's `merge.sh` rules hold) and dispatch of `release.yml` `mode=check|publish`. Not granted: approving an environment deployment, opening PRs, editing files.

Status: built, not deployed. [`STATE.md`](STATE.md) says what is next; [`docs/specs/0000-release-bot-v1.md`](docs/specs/0000-release-bot-v1.md) is the plan and the contract; [`AGENTS.md`](AGENTS.md) is the working agreement.

Target repositories: `tsukuri-labs/tsukuri`, `tsukuri-labs/foldkit-flow`, `phibkro/pg-txmode`, `phibkro/pg-outbox`, `phibkro/vektorprogrammet-reimagined`.

Layout: `packages/rules` (pure: the merge and dispatch decisions, tested against the real `merge.sh`), `packages/service` (Effect services: GitHub App auth and API, ledger, webhook, bot), `apps/bot` (Worker, Durable Object, Alchemy stack, workerd smoke), `tools/quality` (exception registry), `tools/capture` (captures real API responses for fixtures). `devenv shell -- bun run ready` runs every gate. The operator's steps, from creating the App to the first deploy, are in [`docs/operator-checklist.md`](docs/operator-checklist.md) (generated; no secret value in it). Provenance of copied files: [`PROVENANCE.md`](PROVENANCE.md).
