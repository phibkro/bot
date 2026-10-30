# bot

A GitHub App that automates releases for the operator's repositories, hosted on the operator's Cloudflare account as a Durable Object. Read [`README.md`](README.md); [`STATE.md`](STATE.md) says which spec is active. This repository is source-available (all rights reserved): no secret, no personal data in files, logs, fixtures, tests or evidence. Credentials appear as **names and lengths only**, never a value, even partly.

The lifecycle below is the design-spec loop of the projects tier (its `AGENTS.md`, outside this repository). This file links facts that live in the spec; it does not copy them.

## How a change travels

```text
spec → code → PR   (1:1)
```

- **One spec, one branch, one PR.** The spec is `docs/specs/NNNN-*.md`; the branch is `feat/NNNN-<slug>`. If a spec needs two PRs, it was two specs. Spec 0000 is the exception it declares itself: it opens as a spec-only PR and its implementation is a stacked PR (see its "Delivery").
- **Plan and build are one step.** Revise the plan as the build teaches, as a dated entry in the spec's Revisions, never a silent edit. Stop only at an operator-owned fork (preference, authority, external effects: the App, its permissions, secrets, deploys).
- **Freeze the spec when its PR opens.** The PR body is the report and ends with an empty `## Review rounds`; reviewers judge the plan, the code and their agreement.
- **Never block on a merge.** Stack the next branch on the one below.
- **Worktrees:** `git worktree add .worktrees/<name> -b <branch>`. One writer per working directory. Commit by pathspec.
- **Review loop and merge script:** `.agents/skills/review-pr/merge.sh` and `record-round.sh` are copies from `phibkro/pg-txmode`, changing only the provenance line (spec 0000, Revisions 2; see `PROVENANCE.md`). `merge.sh` is also the canonical file of the contract test: do not edit it here; a rule changes in its source repository first.

## What this repository is allowed to hold

- The bot's authority is **merge** and **dispatch of `release.yml`**, nothing else (spec 0000, "Authority"). It never approves an environment deployment, never opens a PR, never edits a file. A change that adds an operation to the GitHub service, a permission to the App or an event subscription is a change of authority: it needs a spec Revisions entry and the operator's decision.
- The merge rules have one home, the pure function derived from each repository's `merge.sh` (spec 0000, D1 to D3). Do not write a second copy of a rule.
- Real credentials never enter Alchemy state, files or logs. Secret names: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`.

## Stack

TypeScript, Bun, Effect v4 (`>=4.1.0`), Oxfmt, Oxlint with the Effect plugin, Alchemy v2 for infrastructure; Cloudflare through `cf` where Alchemy has no resource (with `DO_NOT_TRACK=1`, secrets from stdin; the Wrangler exception of spec 0000, O3, if the operator keeps it). Native Effect: `HttpClient`, `effect/crypto` (`Mac`, `Signature`, `KeyFormat`), `Schema`, `Config`/`Redacted`, `Schedule`, `DateTime`; no `node:crypto`, `fetch`, `process.env`, global timers. Read `.agents/skills/effect-house/SKILL.md` and the installed `node_modules/effect/AGENTS.md` before writing code.

## Checks

`devenv shell -- bun run ready` is the sequence: `check`, `check:effect`, `check:exceptions`, `check:docs`, `test`, `build`, `secrets` (`.agents/skills/effect-house/SKILL.md`). A reviewer runs it and the smoke (`bun run smoke`) from `.agents/skills/verify-bot/SKILL.md`. `bun run docs:gen` regenerates `docs/operator-checklist.md`; never edit it by hand.

## Conventions

- **Conventional Commits** (`feat(scope): …`, `fix: …`, `docs: …`, `chore: …`). Body lines at most 100 characters.
- **Never `--no-verify`.** A rejected commit can leave files staged: check `git status` after a hook failure.
- **Never set or change the git identity.**
- Python only for throwaway work; commit TypeScript.
- Primary sources only in specs: every claim has a URL or a command that was run; an unverified claim is marked INFERENCE.
- Copied code carries its provenance (source repository, commit, deviations).
