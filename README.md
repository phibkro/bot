# bot

A GitHub App that automates releases for the operator's repositories, hosted on the operator's Cloudflare account as a Durable Object. This repository is **private**: no secret, no personal data in files, logs or fixtures (names and lengths only).

```text
reviewed PR ── green CI ──▶ bot merges that exact head ──▶ (version PR) bot dispatches release.yml
            ──▶ bot comments the run URL: the operator clicks "Review deployments" (never the bot)
            ──▶ run ends ──▶ bot reports, per package, whether npm took the OIDC path or the token
```

**Authority:** merge (only when each repository's `merge.sh` rules hold) and dispatch of `release.yml` `mode=check|publish`. Not granted: approving an environment deployment, opening PRs, editing files.

Status: spec. [`STATE.md`](STATE.md) says what is next; [`docs/specs/0000-release-bot-v1.md`](docs/specs/0000-release-bot-v1.md) is the plan and the contract; [`AGENTS.md`](AGENTS.md) is the working agreement.

Target repositories: `tsukuri-labs/tsukuri`, `tsukuri-labs/foldkit-flow`, `phibkro/pg-txmode`, `phibkro/pg-outbox`, `phibkro/vektorprogrammet-reimagined`.
