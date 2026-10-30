# 0000 Release bot v1: merge what was reviewed, dispatch the release, say where to click

Status: **spec** (frozen when its PR opens). Date: 2026-10-30. Decided by: the operator, 2026-10-30 (the operator's decision log, entries "Release bot" and "Publishing preapproval"; not reproduced here): build `phibkro/bot` as a GitHub App on a Cloudflare Durable Object; authority is MERGE (only when each repository's `merge.sh` rules hold) and DISPATCH of `release.yml` `mode=check|publish`; the bot never approves an environment deployment; it may not open PRs or edit files. Forks the operator has not decided are marked **Open** in "Decisions" with a recommendation; the lead resolves them in Revisions.
Process: the design-spec loop of the projects tier (`/srv/share/projects/AGENTS.md`). Based on `main` at `7bd4d2c` (an empty repository: README, licence, `.gitignore`). **This PR carries the spec and the repository skeleton only** (lead's assignment, step 1); the implementation is step 2 and lands as a stacked PR against this spec, with a Revisions entry that records the split.
Verify skill: none yet. Step 2 creates `verify-bot` and `.agents/skills/effect-house/SKILL.md`.
Effect version this spec was written against: `effect@4.1.0` (npm `latest`, read from the package cache, 2026-10-30). Every Effect API named below was read in that package's `src/`; step 2 re-reads the installed copy before writing code (`effect-first`).

How to read the claims: **[V]** verified on 2026-10-30 against the cited primary source or a command run for this spec; **[I]** INFERENCE, stated so that step 2 tests it. The list of sources is the last section.

## Problem

Two chores sit on the lead's session today, and the operator's single human step sits in the middle of them.

```
lead: merge.sh <pr>          waits for CI, checks the head and main, squash-merges
lead: gh workflow run release.yml -f mode=publish     (after the version PR merged and `checks` is green on main)
operator: opens the run, clicks "Review deployments"   <- the one human step; nothing tells the operator it is waiting
lead: reads the run log to see whether npm took the OIDC path or the token
```

Nothing watches while the lead is away, the operator learns of a waiting run by looking, and "OIDC or token" is read by hand from a log that, by default, does not say (see "The report").

## Goal

A GitHub App, **bot**, installed on five repositories and hosted as one Durable Object, that carries a reviewed PR to the operator's click and reports what the click did:

```
 reviewer ── record-round.sh pass ──▶ PR comment/review: <!-- review-round n=N head=H verdict=pass -->
                                              │
 GitHub ── webhook (signed) ─────────────────▶ Worker: verify HMAC, drop strangers
                                              │ delivery id → Durable Object (one per principal)
                                              ▼
   DO: re-read PR, record, checks, main from the API ──▶ decideMerge(facts)        (pure, = merge.sh)
        Merge(H) ── PUT merge-async, sha=H, squash ──▶ main moves to M
        version PR? ── checks green on M, main still M ──▶ decideDispatch(facts)   (pure)
        Dispatch ── POST dispatches release.yml ref=main mode=… ──▶ run R   (environment npm-release waits)
        workflow_job "waiting" ──▶ PR comment: "run R waits for you: <run URL>"
 operator ── clicks Review deployments (never the bot) ──▶ run R publishes
        workflow_run completed ──▶ bot reads the registry: per package, OIDC or token? ──▶ PR comment: report
```

A PR that is not a version PR ends after the merge. Every action the bot takes is one row of an append-only audit log with the facts it decided on.

### Journey (what the operator and the lead experience)

1. A PR is open. The reviewers finish; the lead runs `record-round.sh <pr> <n> pass <body>`. The record is a PR review whose first line is `<!-- review-round n=N head=<40 hex> verdict=pass -->` (read from `record-round.sh` in all five repositories, 2026-10-30).
2. CI finishes green. Within one webhook round trip the bot merges that exact head with `squash`. The lead no longer runs `merge.sh`.
3. If the PR is a version PR (a repository's declared title pattern, for example `chore(release): version packages 0.1.0-alpha.2`), the bot waits for the `checks` check run on the merge commit `M` (the `publish` job requires it: step "The commit passed the checks workflow", present in all four `release.yml` files, read 2026-10-30), confirms `main` is still `M`, then dispatches `release.yml` with the repository's declared mode.
4. When GitHub reports the job as waiting for approval, the bot comments on the merged PR with the run's URL (the dispatch response carries it). The operator clicks **Review deployments**. The bot has no way to do that click (see "Authority").
5. When the run completes, the bot comments: conclusion, and for `mode=publish` one line per `name@version`: `oidc` or `token`, from the registry.

The first weeks run in **observe mode** (see "Rollout"): the bot computes and logs every verdict and takes no write action, so the operator can compare it with the lead's `merge.sh` runs before the bot acts.

## Authority

| Action | Granted | How it is bounded |
| --- | --- | --- |
| Squash-merge a PR into `main` | yes | only when `decideMerge` says `Merge`, only the head `H` the record names (`sha=H`), only a PR that is not in a native stack (V7), only in a configured repository that is not held |
| Dispatch `release.yml` `mode=check` or `publish` | yes | `ref=main` fixed, mode from the repository's config, only for a merged version PR, only while `main` is the merge commit and its `checks` are green |
| Comment on a PR | yes | templates only (no free text from outside); needed for the notification and the report |
| Approve or reject a pending deployment | **no** | three independent bars below |
| Open a PR, push a commit, edit a file, tag, release | **no** | not one code path; see "What `Contents: write` also allows" |
| Read PRs, checks, runs, logs, files | yes | read-only calls through the same narrow service |

**Why the bot cannot approve a deployment** (three independent bars, any one is enough):

1. The API that approves is `POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments`; it needs the **Deployments: write** permission (GitHub's permission table) and the caller must be a required reviewer ("Required reviewers with read access to the repository contents and deployments can use this endpoint"). The bot is not granted Deployments. [V: docs.github.com REST "workflow runs", permissions table]
2. A required reviewer is "up to 6 people or teams"; the reviewer type in the API is `User` or `Team`, never an app. So GitHub cannot make an app a required reviewer, which is the operator's note. [V: docs "Managing environments for deployment"; REST "Get pending deployments" response schema]
3. The bot's `GitHubApi` service has no operation for it, and an egress test fails when the bot ever sends a request outside a declared table of `(method, path)` pairs (falsifier F6).

A separate GitHub feature lets an app **be** a custom deployment protection rule, but "GitHub Apps can only review their own custom deployment protection rules" and a human reviewer rule still stands. The bot does not register one. [V: REST "Review custom deployment protection rules"]

**What the live repositories say (read with the operator's `gh`, read-only, 2026-10-30).** Four repositories have `npm-release` with the single required reviewer `phibkro` (`User`), `prevent_self_review: false`, and a custom deployment branch policy; `tsukuri-labs/tsukuri`, `tsukuri-labs/foldkit-flow`, `phibkro/pg-txmode`, `phibkro/pg-outbox`. `main` is protected there (pull request required, status check `checks`, `enforce_admins: true`, 0 required approvals, no push restrictions, no bypass list, no force push). `phibkro/vektorprogrammet-reimagined` has **no** branch protection, no environments and no release workflow; there the function is the only gate (see O7). All five are public and allow squash merge. Because `prevent_self_review` is false, a run the bot dispatched can still be approved by the operator. [V: `gh api repos/<r>`, `/branches/main/protection`, `/environments`]

## Decisions

Numbering: **D** = decided here on evidence; **O** = open, a fork the lead or operator owns, with a recommendation.

### D1 One pure function for the merge rules, with the two derivations named

`decideMerge(facts): Verdict` is a total deterministic function. It is the **only** place the rules live. Tests and runtime both call it. Its root is `merge.sh`: all five repositories carry the same logic. After removing a leading `# Provenance:` line, the five files hash identically, sha256 `3819dd69d3eb81daba092d01e9558cae5d101cace3ee1a2093054804d2248236` (`vektorprogrammet-reimagined` has no provenance line; the other four have one). [V: `gh api` + `sha256sum`, all five]

The rules, in the order `merge.sh` evaluates them (the order is part of the contract, because exit codes name the first failure):

| # | Check in `merge.sh` | Exit | Verdict |
| --- | --- | --- | --- |
| 1 | a review body or comment body contains `<!-- review-round n=[0-9]+ head=<current head> verdict=pass -->` | 4 | `NoPassRecord` |
| 2 | after waiting for CI, every entry of `statusCheckRollup` is `SUCCESS`, `SKIPPED` or `NEUTRAL` | 1 | `CiNotGreen` |
| 3 | the head is still the reviewed head | 4 | `HeadMoved` |
| 4 | if `origin/main` is not an ancestor of the head: `git merge-tree --write-tree` succeeds | 2 | `ConflictsWithMain` |
| 5 | ... and no file changed on both sides since the merge base | 3 | `OverlapsMain` |
| 6 | `gh pr merge --squash --match-head-commit <head> --subject "<subject> (#n)"` | 0 | `Merge` |

#### Where rules 4 and 5 get their facts at runtime

`merge.sh` runs `git`; a Worker and a Durable Object have no git, so the facts come from the API, and **unknown never merges** (it is `Wait` or a refusal). Step 2 may choose the exact calls; these fields are the contract. [V: REST "Get a pull request", "Compare two commits"; OpenAPI `2026-03-10`]

| Fact | Source | Rule |
| --- | --- | --- |
| `main` is an ancestor of the head | `GET /repos/{o}/{r}/compare/{default-branch}...{H}`: `behind_by == 0` | `0` means rules 4 and 5 do not run, as in `merge.sh` |
| conflicts | the PR object's `mergeable`: `false` is `ConflictsWithMain`; `true` is no conflict; **`null` is `Wait`** (the docs: "GitHub has started a background job to compute the mergeability... resubmit the request"): re-read after a delay, at most 5 reads over about a minute, then `Refuse(Unknown)` | rule 4 |
| files changed on `main` since the merge base | `compare/{merge_base}...{default-branch}` `files[]` | rule 5 |
| files changed on the head since the merge base | `compare/{merge_base}...{H}` `files[]` | rule 5 |
| truncation | the compare file list "includes up to 300 changed files for the entire comparison": a list of **300 or more** entries on either side is `Refuse(Unknown)`, never a smaller set assumed complete | rule 5 |

File sets contain `filename` and, for a rename, `previous_filename`, so the bot may refuse where `merge.sh` merges (`git diff --name-only` lists the new path only [I]); that is a tightening and is allowed. The contract test of D2 uses a real git repository, so it proves `decideMerge` against `merge.sh` on git-shaped facts; it **cannot prove** that these API fields describe the same repository state. That mapping has its own falsifier, **F20**.

### D2 Drift is caught by running `merge.sh`, and pinned by blob

Single source: `merge.sh`. Derivation: `decideMerge`. The edge between them is a **contract test that runs the real script** (the rung "test" of the ladder), plus a **runtime gate** that makes drift refuse instead of merge:

- `test/fixtures/merge.sh` holds the canonical file (the five identical files, provenance line removed; copied with provenance from `phibkro/vektorprogrammet-reimagined@8879c4192c463d5f00d3b8d2574035d33ac26a17`). The contract test puts stub `gh` and `git` executables first on `PATH`, serves each table row's facts as the JSON that `gh pr view --json headRefOid`, `--json comments,reviews`, `--json statusCheckRollup` return and as a real temporary git repository for the `merge-tree` branch, runs the script, and records its exit code and whether the stub `gh pr merge` was called. It then asserts `decideMerge(sameFacts)` maps to the same exit code or merge. The fixtures for `gh` output are **captured from real `gh` runs** (command and raw output committed), never hand-written.
- The git-shaped facts prove the rules, not the API mapping above (F20). The table of rows that the test runs is "Contract table" under D3; step 2 keeps it as data in `test/fixtures/contract-table.*`.
- Each repository's `merge.sh` and `record-round.sh` blob sha is pinned in the bot's config. Before any `Merge`, the bot reads the blob sha of both files on the repository's default branch (`GET /repos/{o}/{r}/contents/{path}` returns `sha`). A mismatch is `Refuse(RulesDrifted)`, an audit row and a PR comment. Changing a repository's `merge.sh` therefore blocks the bot until a bot PR updates the pin, the function and the table together. Pins observed 2026-10-30 (default-branch head in the last column):

| Repository | `merge.sh` blob | `record-round.sh` blob | `main` |
| --- | --- | --- | --- |
| `tsukuri-labs/tsukuri` | `be57b18bfb1782e1277a39468f8d54437a41707f` | `ba7125c524f9e8820027dc911859191cab799de7` | `56a2155e` |
| `tsukuri-labs/foldkit-flow` | `be57b18bfb1782e1277a39468f8d54437a41707f` | `e58524f8ba480d93e2db8d6ad869223d6a4a30f1` | `b52c3b50` |
| `phibkro/pg-txmode` | `40d6be4d7897d56d369af7275e99e4926f933a02` | `646bb10606f1b6683908e8e0f0171ec611032f8b` | `d9b4142d` |
| `phibkro/pg-outbox` | `40d6be4d7897d56d369af7275e99e4926f933a02` | `646bb10606f1b6683908e8e0f0171ec611032f8b` | `7c72902e` |
| `phibkro/vektorprogrammet-reimagined` | `8d6d628300c739067e2bf8f36e2f27450ac22f17` | `de76d08e4b20c1b15a39d06f55897b9cfe91eb97` | `8879c419` |

`tsukuri-labs/tsukuri`'s `record-round.sh` calls `check-record.sh` (blob `5c3bae6d28cd32e79ecdf54074c5c1953ff0d1c9`, the author-is-not-a-reviewer check); that file is pinned and checked at runtime the same way. The five `record-round.sh` files come in three families (pg-txmode and pg-outbox: inline `Author`/`Reviewers` check; foldkit-flow and vektorprogrammet-reimagined: none; tsukuri: `check-record.sh`); the marker lines are the same in all five. [V: `gh api` blob shas; `grep` for `check-record` and `Reviewers`]

A second test runs each pinned `record-round.sh` body format through the bot's record parser (`parseRecord`) so the marker grammar cannot drift from the script that writes it (the marker is the first line; `n` is a positive integer; `head` is 40 hex; `verdict` is `pass` or `changes`).

### D3 The bot is deliberately stricter than `merge.sh` in eight declared places

`merge.sh` was written for a lead who runs it knowingly. A bot that runs unattended on public repositories needs more. Each deviation is a tightening only (the bot may refuse where `merge.sh` merges, never the reverse), is a **row in the contract table that asserts both outcomes** (`merge.sh` merges, `decideMerge` refuses), and so cannot be removed silently.

| # | Deviation | Why | `merge.sh` today |
| --- | --- | --- | --- |
| V1 | The record's author must be a configured **operator account, by numeric user id** | The repositories are public; anyone can comment a forged marker. A login can be renamed and reclaimed, an id cannot. `merge.sh` accepts a marker from anyone. | merges |
| V2 | The marker must be the **first line** of the body | `record-round.sh` always writes it first; a later quote of a marker (a reviewer quoting, a bot echoing a title) must not count | merges |
| V3 | A **later** `verdict=changes` record for the same head blocks. "Later" is by round number `n`, ties by `created_at` (comment) or `submitted_at` (review); a `pass` with a higher `n` than the latest `changes` re-enables. A review in state `DISMISSED` is ignored | a retracted pass must not merge; a dismissed review is withdrawn | merges (it reads every body; `dismissed` included) |
| V4 | **Added to rule 2, never in place of it.** Rule 2 holds unchanged for **every** entry, required or not (`SUCCESS`, `SKIPPED` or `NEUTRAL`). In addition each name in `requiredChecks` has a **completed check run from the `github-actions` app** with conclusion `success` (a skipped required check does not count) | `gh pr checks --watch ... \|\| true` followed by "zero bad entries" merges a PR whose CI has not registered yet; the four protection rules have `app_id: null`, so any app's run named `checks` satisfies GitHub, and the bot can be tighter | merges (an empty rollup has no bad entry; a skipped required check passes; any app's run counts) |
| V5 | The PR is **open, not a draft, from the same repository, into the default branch** (a base-branch chain is covered here; a native stack is V7), and its title is a Conventional Commit subject | the merge commit title is the PR title; a fork head can change under review | no check |
| V6 | The repository is **not held**: no `.github/bot-hold` on the default branch | the per-repository kill switch (see "Kill switch") | no check |
| V7 | The PR is **not in a native stack**: the PR object's `stack` is null (API `2026-03-10`) | `merge-async` "is the required API for merging stacked pull requests. For a stacked pull request, the operation includes all open downstack pull requests", so "merge only `H`" holds only outside a stack; `Refuse(Stacked)` | merges (a different set of commits than reviewed) |
| V8 | A record's **body is unchanged** since the bot first read it as a pass (its sha256 is stored with the first-seen row); a change is `Refuse(RecordChanged)` until a new round | a write collaborator can edit another user's comment while the author id stays the operator's | merges |

Status contexts (commit statuses, as opposed to check runs) are mapped as `merge.sh` would count them, as **not green** unless the rollup entry has `conclusion` `SUCCESS`; [I] `gh` emits no `conclusion` for a `StatusContext`, so `jq` sees `null != "SUCCESS"` and counts it bad. Step 2 captures a real rollup that contains a status context to settle this; until then the bot fails closed.

#### Contract table

The oracle for F10: each row is facts, the exit code or "merge called" of the real `merge.sh`, and the `decideMerge` verdict. **Base rows** must agree; **deviation rows** (V1 to V8) assert that `merge.sh` merges and `decideMerge` refuses, so removing a deviation fails the test. "Wait" is the bot's form of `merge.sh`'s `gh pr checks --watch`; on an unsettled rollup the real script, after its watch, exits 1. Step 2 may add rows, never remove one without a Revisions entry.

| Row | Facts | `merge.sh` | `decideMerge` |
| --- | --- | --- | --- |
| M01 | pass on `H`, all checks `SUCCESS`, `main` an ancestor | merge | `Merge` |
| M02 | no record | 4 | `NoPassRecord` |
| M03 | pass names an older head | 4 | `NoPassRecord` |
| M04 | only a `changes` record on `H` | 4 | `NoPassRecord` |
| M05 / M06 | pass in a review body / in an issue comment | merge | `Merge` |
| M07 | a required check `FAILURE` | 1 | `CiNotGreen` |
| M08 | a **non-required** check `FAILURE` | 1 | `CiNotGreen` |
| M09 | an entry `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED` or `STARTUP_FAILURE` | 1 | `CiNotGreen` |
| M10 | entries `SUCCESS`, `SKIPPED`, `NEUTRAL` only | merge | `Merge` |
| M11 | an entry with no conclusion (unsettled) | 1 | `Wait` |
| M12 | no record and red CI | 4 | `NoPassRecord` (order) |
| M13 | red CI and head moved during CI | 1 | `CiNotGreen` (order) |
| M14 | green CI, head moved during CI | 4 | `HeadMoved` |
| M15 | `main` moved, conflicts | 2 | `ConflictsWithMain` |
| M16 | `main` moved, a file changed on both sides, no conflict | 3 | `OverlapsMain` |
| M17 | `main` moved, conflicts and overlap | 2 | `ConflictsWithMain` (order) |
| M18 | `main` moved, disjoint files | merge | `Merge` |
| M19 | `main` is an ancestor of the head | merge | `Merge` |
| M20 | a rollup entry that is a commit status (no `conclusion`) [I] | 1 | `CiNotGreen` |
| X01 (V1) | pass posted by a non-operator account | merge | `Refuse(RecordAuthor)` |
| X02 (V2) | marker quoted, not the first line | merge | `Refuse(NoPassRecord)` |
| X03 (V3) | `pass` n=2 then `changes` n=3, same head | merge | `Refuse(NoPassRecord)` |
| X04 (V3) | the only pass sits in a `DISMISSED` review | merge | `Refuse(NoPassRecord)` |
| X05 (V4) | empty rollup | merge | `Refuse(RequiredCheckMissing)` |
| X06 (V4) | a required check absent, others green | merge | `Refuse(RequiredCheckMissing)` |
| X07 (V4) | a required check `SKIPPED` | merge | `Refuse(RequiredCheckMissing)` |
| X08 (V4) | the required check came from another app | merge | `Refuse(RequiredCheckMissing)` |
| X09 (V5) | draft, fork head, base not the default branch, or title not a Conventional Commit | merge | `Refuse(PrState)` |
| X10 (V6) | `.github/bot-hold` present | merge | `Refuse(Held)` |
| X11 (V7) | the PR is in a native stack | merge | `Refuse(Stacked)` |
| X12 (V8) | the record body changed since first read | merge | `Refuse(RecordChanged)` |

### D4 Webhooks are hints; the API is the truth

A delivery tells the bot **what to look at again** (a repository, a PR number, a sha, a run id). It never carries a fact the bot acts on. Every decision re-reads PR, head, records, check runs and `main` from the API. Consequences: a replayed or reordered signed delivery can cause an extra read and nothing else; a webhook missed during an outage is repaired by a **reconcile sweep** (an alarm every 10 minutes lists open PRs of configured repositories and re-evaluates those that have a pass record); the stored state is small. Cost: about 6 to 10 reads per evaluation; at 5 repositories and a sweep every 10 minutes that is about 1,500 reads a day plus event-driven reads, against the installation's minimum of 5,000 requests an hour. [V: docs "Rate limits for the REST API", installation primary limit]

### D5 Release dispatch has its own pure function, bound to the merge commit

`decideDispatch(facts): Verdict` returns `Dispatch(mode)` only when all hold: the repository is configured with a `release` block and is in `act` mode and not held; the merged PR's title matches the repository's declared version-PR pattern; a pass record by an operator account named the PR's **final** head; the PR was merged into `main` as commit `M`; `main` **is** `M` right now; the `checks` check run on `M` concluded `success`; `.github/release-hold` is absent at `M` (the workflow's own hold, read so the bot does not spend an approval click on a run that fails at once); the ledger has no dispatch for `(repo, M, mode)`.

"`main` is still `M`" matters because `workflow_dispatch` takes a branch, not a sha: the run builds the tip of `main` at trigger time. If another commit lands between the merge and the dispatch, a publish would put code that was never part of the version PR under the version's number. The bot therefore (a) refuses other merges in that repository from the moment it merges a version PR until the **lock ends**, and (b) re-reads `main` immediately before the dispatch. The lock ends when the dispatch is recorded; or when `checks` on `M` concluded without `success` (no dispatch, one comment, unlock); or when `releaseLockTimeout` (config, default 30 minutes) has passed since the merge with `checks` still unfinished (no dispatch, one comment, unlock). A human merge in that window leaves a residual race of one API round trip, which step 2 reports as a known limit. Pinning a sha belongs to the workflows (an `expected_sha` input checked by the `publish` job), a change to four repositories that this spec recommends and does not make. [V: REST "Create a workflow dispatch event": `ref` is "a branch or tag name"; `release.yml`: `publish` runs `if: github.ref == 'refs/heads/main'` and its checkout step has no `ref`] [I] that a checkout without `ref` is the commit the run was created for, so a commit that lands after the dispatch does not change what the run publishes.

Modes come from config: `["publish"]` by default; `["check", "publish"]` dispatches `check`, waits for it to conclude `success` and for the operator's click on it, then dispatches `publish` (two clicks). Both modes use `environment: npm-release`, so **both wait for the operator** (`release.yml`, jobs `check` and `publish`). [V]

### D6 The dispatch response carries the run id (one API version, `2026-03-10`, on every call)

The bot sends `X-GitHub-Api-Version: 2026-03-10` on **every** request and decodes every response with that version's schema; versions are never mixed. In `2026-03-10` the dispatch endpoint takes only `ref` and `inputs` and **always** answers `200` with `workflow_run_id`, `run_url` and `html_url`. The parameter `return_run_details` belongs to `2022-11-28` and was **removed** in `2026-03-10` (GitHub's API changelog: "Change workflow dispatch response from `204` to `200` with workflow run details. Removes the `return_run_details` parameter. The endpoint now always returns `200`..."; OpenAPI: `2022-11-28` body `inputs, ref, return_run_details`, responses `200, 204`; `2026-03-10` body `inputs, ref`, responses `200`). Anything other than a `200` that decodes is a **failed call**; a `204` would mean an older version was served. The 2026-02-19 blog post describes the `2022-11-28` behaviour. [V: `github/rest-api-description` `CHANGELOG.md` and both OpenAPI files, checked by the round 1 reviewer and again by the author] The `html_url` is the approval link; GitHub's own text for the click is "On the notification, click **Review deployments**". [V: docs "Reviewing deployments"]

### D7 Merge call: asynchronous API, `bypass_rules` never true

`PUT /repos/{o}/{r}/pulls/{n}/merge-async` with `merge_method: squash`, `merge_action: direct_merge`, `sha: H`, `commit_title: "<PR title> (#n)"`, `bypass_rules: false`. GitHub recommends it over the synchronous endpoint; it is **idempotent by construction** (already merged: `200` with the merge commit; duplicate pending: `409` with the first request's id), its `sha` cancels the merge when the head moved, and it returns `202` and a uuid to poll with `GET .../merge-async/{uuid}` (`status`: `pending`, `merged`, `enqueued`, `failed`). "Branch protection rules and repository rules are not run at this stage": a protection failure appears in the polled result, not in the `202`. The poll is listed under Contents **write** in GitHub's permission map, so the write token is held through the poll. **Stacks:** the endpoint "is the required API for merging stacked pull requests. For a stacked pull request, the operation includes all open downstack pull requests", so "the bot merges only `H`" is true only for a PR outside a native stack; V7 refuses a PR whose `stack` is not null. [V: REST "pulls"; the PR object has a `stack` property and the API has `/repos/{o}/{r}/stacks` in `2026-03-10`] The permission is the same as for the synchronous call.

### D8 Notification channel: a PR comment, behind a `Notifier` service

A comment on the merged PR is durable, linkable, needs no new secret, and GitHub notifies the PR's author and subscribers. Telegram later implements the same `Notifier`. A comment never contains text from outside the repository except the PR title, rendered as inline code with backticks stripped and `<`, `@`, `#` escaped, so a title cannot plant a review marker that another consumer (such as `merge.sh`) would match (F13). [V] that `merge.sh` greps every comment and review body for the marker; [V] that a bot comment reaches it. See O5 for the channel choice.

### D9 What the bot writes down (the Durable Object)

One SQLite-backed Durable Object per principal (`getByName("operator")`), all five repositories in it. Storage guarantee, named per write (`effect-persistence-workflows`):

| Table | Holds | Guarantee |
| --- | --- | --- |
| `rb_deliveries` | `delivery_id` (primary key, GitHub's `X-GitHub-Delivery`), event, action, repository, hint (pr number, sha or run id), `received_at`, `state` | **admitted**: the row is committed before the Worker answers `202`. Duplicate id: `INSERT` conflicts, answer `200`, nothing else happens. A redelivery has the same id. [V: docs "Best practices for using webhooks"] |
| `rb_work` | a queue of `(repository, subject, due_at, attempts)` wake-ups | at-least-once. The alarm drains it. Exceptions are caught and re-scheduled (alarms stop retrying after 6 failures, so the handler never lets an exception escape). [V: Cloudflare "Alarms"] |
| `rb_actions` | the **idempotency ledger**: `key` (primary key, for example `merge:phibkro/pg-txmode#18@<head>`, `dispatch:<repo>@<M>:publish`, `comment:<repo>#<n>:approval:<run>`), `kind`, `intent_at`, `receipt`, `receipt_at` | **intent before effect**: the row is written, then the call leaves. The DO's output gate holds the outgoing request until the write is stored. [V: Cloudflare "Rules of Durable Objects"] A second evaluation that finds an intent without a receipt **does not call again**: it reads the outcome back from GitHub (PR `merged`/`merge_commit_sha`, a workflow run for `head_sha = M` and `event = workflow_dispatch`, a comment carrying the marker) and writes the receipt. |
| `rb_prs`, `rb_runs` | per-PR state (`Tracking`, `Ready`, `Merged`) and per-run state (`Dispatched`, `Waiting`, `Concluded`, `Reported`) | derived; can be rebuilt by a sweep. Not a source of truth. |
| `rb_audit` | append-only: time, kind, repository, subject, delivery id, the facts the decision used (as JSON, no secret), verdict, the request line of any call | SQLite triggers reject `UPDATE` and `DELETE`. Point-in-time recovery covers 30 days. [V: Cloudflare SQLite storage API] |

Receipt meanings: a delivery receipt is "admitted" only. A merge receipt is "committed on GitHub" (merge commit sha). A dispatch receipt is "run created" (run id), never "published". A report receipt is "comment exists". Nothing in v1 claims exactly-once for an external effect; each has an idempotency key and a read-back, which makes a repeat harmless or visible. The Effect SQL driver for it is `@effect/sql-sqlite-do@4.1.0`, which takes `storage: DurableObjectStorage` for transactions and migrations (the `db`-only form has no transactions). [V: package source]

Table names are prefixed `rb_` so later tables (`memory_log`, `memory_tree` of the OptMem port, and the `pi_` tables of PiHarness) cannot collide. [V: `pi_` prefix, Cloudflare "Pi" docs]

### D10 Signature verification and the app key use Effect's crypto services

`effect/crypto` (4.1.0, `@stability unstable`; `allowedUnstableApis` names it in step 2) provides everything, so `node:crypto` is never imported:

- Webhook: `Mac.Mac.verify(key, tag, bytes)` over the **raw request bytes** with `Mac.hmacSha256`; it compares in constant time and returns `false` for a tag of the wrong length. The tag is the hex after `sha256=` in `X-Hub-Signature-256`. Test vector from GitHub: secret `It's a Secret to Everybody`, payload `Hello, World!`, signature `757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`. [V]
- App JWT: RS256, `iat` 60 seconds in the past, `exp` at most 10 minutes ahead, `iss` the app's client id. `KeyFormat.decodePrivate(Signature.rsaPkcs1v15Sha256, KeyFormat.pem(KeyFormat.pkcs1), pem)` imports the downloaded PEM (`pkcs1` is import-only and exists for exactly this), then `Signature.sign`. [V: GitHub JWT doc; Effect `KeyFormat.ts`, `Signature.ts`] [I] GitHub's downloaded key is PKCS#1 (`BEGIN RSA PRIVATE KEY`) and a 2048-bit key imports although `rsaPkcs1v15Sha256`'s declared `modulusLength` is 3072 (that field is for key generation); step 2 tests with a freshly generated 2048-bit PKCS#1 key.
- Layers: `Mac.layerWebCrypto` and `Signature.layerWebCrypto` on `SecureRandom.layerWebCrypto`, the Workers `crypto.subtle`.

Installation tokens: `POST /app/installations/{id}/access_tokens` expires after one hour; the body accepts `permissions` and `repositories`. The bot **mints one token per capability**, each narrowed to the least permission and to the one repository: a read token (no write permission) for every read; a `contents: write` token that is held in memory for the one merge call **and its poll**; an `actions: write` token for the one dispatch call; an `issues: write` token for a comment. A token is never persisted. Since 2026-04-27 new installation tokens use a longer stateless format (`ghs_<appid>_<jwt>`), so no schema may assume 40 characters. [V]

### D11 Effect shape (constraints on step 2, not the layout)

Plain functions: `decideMerge`, `decideDispatch`, `parseRecord`, `classifyPublisher`, `renderComment`, the sorting and mapping of check conclusions. Services: `GitHubApp` (JWT, token minting), `GitHubApi` (exactly the declared operations), `NpmRegistry` (public reads over `HttpClient`), `ReleaseLedger` (the tables above), `Notifier` (PR comment), `WebhookVerifier`. The Worker's `fetch` is `HttpRouter.toWebHandler`; the DO is Alchemy v2's Effect-native `DurableObject` with its `alarm` handler; one composition root per host. Layout rule from the architecture decisions: the rules package depends only on libraries (no platform, no HTTP); services depend on libraries; the Worker and Durable Object host are the platform integration. Every GitHub payload and every API response is decoded with a Schema at the service that receives it; a decode failure is a defect plus an audit row, never an action. Interruption and eviction are expected: a test interrupts between intent and call (F14).

### O1 (Open) Does v1 need PiHarness at all? **Recommendation: no.**

The operator's note names PiHarness (`@earendil-works/pi-durable`, mounted through `agents/harness/pi` with `Lifecycle.install(this)`) for the first version. Nothing on the v1 path needs a model: the merge and dispatch decisions are D1 and D5; the notification and the report are templates over typed fields; the OIDC-or-token answer is a registry field (see "The report"). The tradeoff, with what was read:

| | A: plain Durable Object (recommended) | B: PiHarness in the same Durable Object, model limited to a read-only narrator |
| --- | --- | --- |
| Authority path | all deterministic; a prompt cannot reach it | deterministic path unchanged; the model sits next to it in one isolate |
| Host shape | Alchemy's Effect-native `DurableObject` (`DurableObjectShape`: `fetch`, `alarm`) | `Lifecycle.install(host: DurableObject<Env>)` needs a real `cloudflare:workers` `DurableObject` class instance and **installs the `fetch` and `alarm` handlers**; our reconciler's alarm would become a Lifecycle capability or share its alarm. Alchemy supports class-based async Durable Objects, so it is possible, but the Effect-native shell would not be used [V: `agents@0.32.0` d.ts; Alchemy `DurableObject.ts`] |
| Stability | Effect 4.1, Alchemy beta.84 | adds `agents` 0.32 with peers `@earendil-works/pi-durable ~1.4.0`, `pi-ai ~1.4.0`; "Pi Durable is experimental and its API can change in minor releases" and the Cloudflare changelog calls `PiHarness` beta [V] |
| Tool gating | not applicable | "Pi Durable has no approval or permission step for tool calls yet" [V]: only tools that cannot act are acceptable, enforced by the registry (a tool named `merge` must not exist; falsifier F18) |
| Model cost and tests | none | a model binding (Workers AI or AI Gateway), nondeterministic output, recorded fixtures for tests |
| What it adds | nothing the DoD needs | prose: why CI is red, what a failed run's log says; and the home for memory and Telegram the operator planned |

A and B share every domain construct; B adds a `Narrator` implementation and changes the host shell. Moving later costs the host shell, not the domain. Recommendation: A in v1, reserve the `Narrator` seam (the `Notifier` takes a message, so a narrator can supply a paragraph), and write PiHarness as spec 0001 when there is a concrete model job (failure explanations, then memory). This departs from the operator's wording "first version = release agent on PiHarness", so it is the operator's call; if B is chosen the spec's only change is a section on the narrator's tools (below) and the host shape.

### O2 (Open) App ownership and visibility. **Recommendation: one public-installable App owned by `phibkro`, with an installation allowlist by numeric account id.**

The five repositories sit on two accounts: user `phibkro` (id 71797726: `pg-txmode`, `pg-outbox`, `vektorprogrammet-reimagined`) and organisation `tsukuri-labs` (id 349117663: `tsukuri`, `foldkit-flow`). A **private** GitHub App "can only be installed on the account that owns the app". [V: docs "Making a GitHub App public or private"; ids from `gh api users/phibkro`, `orgs/tsukuri-labs`]

| Option | Effect |
| --- | --- |
| 1 (recommended) one App owned by `phibkro`, set to installable by any account | one key, one webhook secret, one URL, one set of manual steps. A stranger can install it, which sends us webhooks and nothing else: the Worker drops any delivery whose installation account id is not in the allowlist **before** touching the Durable Object, and tokens are minted only for installation ids that `GET /app/installations` returns for allowlisted accounts, never for an id taken from a payload |
| 2 two private Apps (one per owner) | no public landing page, twice the secrets and steps, two webhook URLs or one URL with an app id routing; code is identical |
| 3 private App on `tsukuri-labs` only | cannot cover three of the five repositories |

Hard to reverse in this sense: the App's slug and public page exist as soon as it is made public; an App can change owner later but not its identity. The allowlist is code (a PR), so a stranger's install changes nothing.

### O3 (Open) Where the two secret values live. **Recommendation: Worker secrets set from stdin with Wrangler, recorded as a house exception until `cf` can do it.**

The house rule is "use `cf`, pipe secret values through stdin". The Cloudflare CLI documentation says "`cf` cannot set a single secret yet": the options are `wrangler secret put <NAME> --name <WORKER>` or uploading secrets with a new Worker version through `--secrets-file <PATH>` of `cf deploy` or `cf workers versions create`. [V: developers.cloudflare.com/cf, "What still needs Wrangler" and "Commands not yet supported"; `cf` itself is not installed on this machine]

| Option | Effect |
| --- | --- |
| 1 (recommended) `wrangler secret put` from stdin, one registered exception, retired when `cf` supports single secrets | value never in a file, never in Alchemy state; the exception is the use of Wrangler, named in the house exception style |
| 2 `cf deploy --secrets-file` | needs a 0600 file with the private key on disk for the deploy, and [I] a `cf` version upload may fight Alchemy's own deploy of the same Worker |
| 3 Secrets Store (open beta) with a `secretsStoreSecret` binding | the value sits in an account store; the binding is declared in Alchemy and holds only a store id and a name; [I] `cf` has a command for creating a store secret (it mirrors the API), not checked; reads are async; beta |

Secret names (values are never written down): `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`. Not secret, so plain Worker vars: `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`. Secrets are read through Effect `Config` (`Config.redacted`) when the layer is built and travel as `Redacted`; `rb_audit` and logs never contain a value (F12).

### O4 (Open) How a version PR is recognised, and which mode runs. **Recommendation: a declared title pattern per repository, mode `publish`.**

Version PRs in `pg-txmode` are titled `chore(release): version packages 0.1.0-alpha.2 (all five, spec 0008)` on branches `chore/version-<ver>`, and they touch changeset, changelog and manifest files (PR 18 changes 11 files whose path matches `.changeset`, `CHANGELOG` or `package.json`, read with `gh pr list --json files`). [V]

| Option | Effect |
| --- | --- |
| 1 (recommended) the title prefix `chore(release): version packages` plus base `main`, declared per repository in config | simple; a wrong title can only cause a dispatch that GitHub then gates behind the click, and `publish` skips versions already on the registry |
| 2 structure: the PR changes `.changeset/pre.json` or deletes `.changeset/*.md` and edits manifests | harder to get right across repositories; add as a second condition later |
| 3 intent in the record: an extra `Release: publish` line in the operator's own `pass` record | authority comes from the trusted record, but it changes `record-round.sh` usage in five repositories |

Modes: `publish` only by default, matching the operator's preapproval ("dispatch `mode=publish` (and `mode=check`)... once a version PR has a recorded review pass, is merged and its `checks` run is green"). `["check", "publish"]` is available per repository.

### O5 (Open) Notification channel in v1. **Recommendation: PR comment now.**

Alternatives: the house's `ntfy` (a topic that is itself a secret and a new egress), or wait for Telegram. A PR comment on the merged PR needs no new secret and doubles as the record. Telegram and `ntfy` implement `Notifier` later.

### O6 (Open) Who may record a pass. **Recommendation: the operator's account only, by numeric id.**

Records are posted by `record-round.sh` through `gh pr review` using the operator's own login, so the allowlist today is `{ id: 71797726 }`. This also means **anything holding that account's `gh` token can authorise a merge**, exactly as with `merge.sh` today. A dedicated reviewer machine user would narrow that; it is a later change of one config entry. `record-round.sh` already refuses a pass whose `Author:` line is among the `Reviewers:` (self-declared names, so it stops mistakes, not forgery); the bot does not duplicate that check. **Edits:** a write collaborator can edit another user's comment, so a record's author id can stay the operator's while its text changes. V8 pins the body's sha256 at the bot's first read and refuses a later change; an edit made before the first read is not detectable and is an accepted residual while the operator is the only writer.

### O7 (Open) `phibkro/vektorprogrammet-reimagined` has no branch protection. **Recommendation: protect `main` there (required check `checks`) before its mode becomes `act`.**

There the bot's function is the only gate. Its `main` head also shows `checks` as `failure` today (`gh api .../commits/main/check-runs`, 2026-10-30), which is the sort of thing GitHub's required-check rule would have refused. Not a blocker for observe mode.

### O8 (Open) Hardening that GitHub, not the bot, can enforce. **Recommendation: a tag ruleset and branch-creation restriction on the four release repositories; optional.**

See "What `Contents: write` also allows". Neither is needed for the DoD; both shrink the blast radius of a stolen App key.

### D12 Out of scope for v1

PiHarness (O1), the OptMem memory (`memory_log`, `memory_tree`: [V] `VictorTaelin/OptMem@1fb164cf` is a Python tool with 280-byte records, aligned power-of-two summary blocks and `cover(T, budget)`; [V] the repository has **no licence file** (the API reports `license: null`), so a port needs the author's permission or a clean-room implementation from the described algorithm), Telegram, a sandbox, a command channel, approval reminders, opening PRs, editing files, `expected_sha` in the four workflows, changing any repository's `merge.sh`.

## GitHub App: permissions and events

Mapping read from GitHub's own data (`github/docs`, `src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json`, the source of the page "Permissions required for GitHub Apps"). [V]

### Repository permissions

| Permission | Level | Needed for | Not needed, so not asked |
| --- | --- | --- | --- |
| Metadata | read | mandatory for every App | |
| Pull requests | read | `GET pulls/{n}`, `/reviews`, `/files`, `/commits`; the `pull_request` and `pull_request_review` events | |
| Issues | **write** | read and create PR comments (`/issues/{n}/comments` accepts Issues or Pull requests); the `issue_comment` event needs Issues read | |
| Contents | **write** | the merge: `PUT .../pulls/{n}/merge` and `merge-async` list **only Contents: write**, additional-permissions false; also reads of `compare`, `contents`, `commits` | |
| Checks | read | `GET commits/{ref}/check-runs`; the `check_run` event | |
| Commit statuses | read | `GET commits/{ref}/status`; the `status` event | |
| Actions | **write** | `POST .../workflows/{id}/dispatches`; run, job, log reads, `GET .../pending_deployments` (read) and the `workflow_run`, `workflow_job` events | |

**Pull requests: write is not requested, on purpose.** It does not authorise the merge (the permission map lists `PUT .../merge` under Contents only), and it would authorise `POST /pulls` (open a PR) and `POST .../pulls/{n}/reviews` (submit a review, including an approval), both outside the operator's grant. Issues: write is the narrower way to comment. Not granted at all: Deployments (the approval endpoint), Environments, Workflows (editing `.github/workflows/*`), Administration, Secrets, Variables, Members. The answer to "does Pull requests: write alone suffice for a squash merge": **no, it is Contents: write.**

**Branch protection and the merge.** The four protected repositories require a pull request and the status check `checks`, with 0 required approvals, `enforce_admins`, no push restriction list and no bypass list. The App is not an administrator and cannot bypass, so its merge succeeds exactly when `checks` has passed, and a direct push to `main` by it is refused. Reviews are PR comments, so no required-review rule stands in the way. If the operator later adds a push restriction list, the App must be added to it [I: the API merge counts as a push for that list]. `bypass_rules` is always `false`.

**What `Contents: write` also allows.** Per the same table, besides the merge: `PUT` and `DELETE` on `contents/{path}`, `POST /git/refs`, `PATCH` and `DELETE /git/refs/{ref}` (create, move and delete branches and tags), `POST /git/blobs`, `/git/trees`, `/git/commits`, `/git/tags`, `POST /releases`, `POST /merges`, `POST /dispatches` (repository dispatch), `POST /merge-upstream`. So a **permission set cannot express "may merge but not edit files"**; the operator's "not granted: editing files" holds because (a) the bot has no code path for any of it and an egress test proves the request set (F6), (b) `main` is protected including administrators, so even a stolen key cannot write to it, (c) the App lacks **Workflows**, which is required to create or update a workflow file, and (d) the `npm-release` environment accepts only its configured branches and needs the operator's click. The residual that GitHub's permission cannot close: with a stolen key an attacker could create or delete non-protected branches and tags and edit files on them. O8 closes most of it.

### Webhook events to subscribe to

| Event (actions used) | Permission it needs | Why |
| --- | --- | --- |
| `pull_request_review` (`submitted`, `edited`, `dismissed`) | Pull requests read | the record arrives as a review body |
| `issue_comment` (`created`, `edited`, `deleted`) | Issues read | `merge.sh` also accepts a marker in a plain comment |
| `pull_request` (`opened`, `synchronize`, `edited`, `closed`, `ready_for_review`, `converted_to_draft`) | Pull requests read | head moved, merged, closed |
| `check_run` (`completed`) | Checks read | CI settled on a head or on `M` |
| `status` | Commit statuses read | a commit status is part of the rollup (D3) |
| `workflow_job` (`waiting`, `completed`) | Actions read | `waiting` is "a job in a workflow run was created and is waiting for approvals" |
| `workflow_run` (`completed`) | Actions read | the run finished |
| `installation` (`suspend`, `unsuspend`, `deleted`) | none, sent to every App | the installation kill switch |

Payloads are capped at 25 MB; the Worker answers within 10 seconds or GitHub records a failure and does **not** redeliver on its own. [V: docs "Webhook events and payloads", "Handling failed webhook deliveries"] The reconcile sweep is the answer to that.

### Rate and abuse budget

The installation's primary limit is a minimum of 5,000 requests an hour for a non-enterprise installation, scaling to at most 12,500 (50 more per repository above 20 and per user above 20). Secondary limits: at most 100 concurrent requests, 900 points a minute per endpoint, and about 80 content-creating requests a minute and 500 an hour. A `403` or `429` with `retry-after` is obeyed; with `x-ratelimit-remaining: 0` the bot waits for `x-ratelimit-reset`; otherwise it waits at least a minute. The bot sends one write at a time per repository. [V: docs "Rate limits for the REST API"]

## Rollout and kill switch

**Observe mode.** Each repository's config has `mode: "observe" | "act"`. In `observe` the Durable Object evaluates and writes `rb_audit` rows, and the egress test (F11) proves it sends no write request. The operator compares the bot's verdicts with `merge.sh` runs for a period they choose, then flips a repository to `act` with a config PR. Default for all five at deploy: `observe`.

**Kill switches**, from narrowest to widest:

| Switch | Who | Effect | Test |
| --- | --- | --- | --- |
| `.github/bot-hold` on a repository's default branch | anyone who can merge a PR there | every verdict for that repository is `Refuse(Held)`; the bot reads the file by `GET contents` on each evaluation (404 means no hold). It mirrors `.github/release-hold` | F11 |
| config `mode: observe` for a repository | a bot PR | same as above, durable in code | F11 |
| installation **suspend** or **uninstall** in GitHub settings | the account owner | the `installation` event `suspend` or `deleted` sets a `suspended` flag in the Durable Object that refuses every action until `unsuspend`; [I] GitHub also rejects the token mint for a suspended installation | F11 |
| delete the App's private key, or delete the Worker | the operator | the bot can no longer mint a token at all | manual |

There is no admin endpoint in v1: one would be a new authenticated surface to protect, and the GitHub-side switches are already instantaneous.

## The report: OIDC or token

The operator asked for the path to be reported "from the log". The log does not say, at the level `release.yml` runs: npm's OIDC outcome is logged only at `verbose` level (`npm/cli`, `lib/utils/oidc.js`: `log.verbose('oidc', 'Successfully retrieved and set token')`, `'Failed token exchange request with body message: ...'`), and `release.yml` runs `npm publish` at the default level. Provenance is not a discriminator either: `NPM_CONFIG_PROVENANCE=true` signs provenance on the token path too. [V: npm/cli `latest`, commit `9741b645b` of 2026-09-30; `release.yml`]

The registry does say, durably and for a public package without credentials. On 2026-10-30, `npm view @pg-txmode/core@<v> _npmUser`:

| Version | `_npmUser` | Has provenance attestation | Published by |
| --- | --- | --- | --- |
| `0.1.0-alpha.0` | `phibkro <...>` | yes | token path |
| `0.1.0-alpha.1` | `phibkro <...>` | yes | token path |
| `0.1.0-alpha.2` | `GitHub Actions <npm-oidc-no-reply@github.com>` | yes | OIDC (trusted publisher) |

So `classifyPublisher(packument)` is: `_npmUser` email `npm-oidc-no-reply@github.com` means `oidc`; anything else means `token`; an absent version means `not-published`. [V for these three versions and for `@tsukuri/core@alpha`, `GitHub Actions`; [I] that this is a stable contract of the npm registry (observed, not documented)]. The set of `name@version` to check comes from the merged version PR itself: every non-private `package.json` it changed, read at `M` (Contents read), not from a log. The run's log is read only as a human-readable cross-check and, in B, as the narrator's input. `mode=check` never uses OIDC (the `check` job has no `id-token` permission), so its report says `token path only`.

## Failure modes

| Failure | What the bot does |
| --- | --- |
| Same delivery twice (GitHub redelivers with the same `X-GitHub-Delivery`) | `rb_deliveries` conflict: `200`, no work |
| Two different deliveries about the same PR at once (review and check run) | both enqueue work; `rb_actions` key `merge:<repo>#<n>@<H>` is claimed once; the second sees the intent and reads back |
| Force-push after the pass | the record names `H`; `decideMerge` compares it with the head just read; the merge call carries `sha=H`, so GitHub cancels it if the head moved in between. The pass cannot transfer to a new head (F2) |
| CI re-run turns red after green | the checks are read again before the call; the merge needs green at the moment of the decision |
| CI not finished | `Wait` (not a refusal): the `check_run` completion event wakes the evaluation |
| `main` moved, files overlap or conflict | `Refuse(OverlapsMain)` or `ConflictsWithMain` plus a PR comment: rebase, push, a new round |
| Merge accepted (`202`) but the poll says `failed` | audit row, one PR comment with the reason, no retry until a new event |
| Alarm or Durable Object evicted between intent and call | the next alarm finds an intent without a receipt and reads back instead of calling (F14) |
| Dispatch returns `204`, `404` or `422` | the call failed; audit row; no retry loop; a PR comment says which |
| Dispatch call times out | read back by listing runs (`event=workflow_dispatch`, `head_sha=M`, created after the intent); never a blind second dispatch |
| Main moves past `M` before dispatch | no dispatch; a PR comment explains (D5) |
| The approval is never clicked | nothing; GitHub keeps the run waiting. No reminder in v1 (D12) |
| The run fails or is cancelled | the report says the conclusion; no package lines |
| npm registry lags after publish | the report retries on a bounded schedule (a few minutes) and then says `not yet visible` |
| GitHub rate limit | obey `retry-after` / reset; the work item is re-scheduled, not dropped |
| The private key is revoked, or token minting returns `401` | audit row, a flag `degraded`, no action; the operator sees it in logs and in missing comments |
| A payload or response fails its Schema | defect plus audit row; no action on that item |

## Threat model

Assets: merge on five `main` branches; dispatch of a release; the App private key; the webhook secret; the audit log.

| Threat | Mitigation | Falsifier |
| --- | --- | --- |
| Forged webhook | HMAC over the raw bytes before parsing; a bad or missing signature is `401` and never reaches the Durable Object; GitHub's published vector passes | F5 |
| A stranger comments a forged `pass` marker on a public PR | record author must be an operator account by numeric id (V1); the marker must be the first line (V2) | F1 |
| Replay of a signed delivery | the delivery id is unique; payloads are hints (D4) | F4 |
| Force-push after the pass | `sha=H` on the merge call; the record names the head | F2 |
| Prompt injection through PR title, body, comments, commit messages or CI logs | v1 has no model on the path. The text is only data: parsed by strict grammars (`parseRecord`, the title pattern), the title is echoed escaped, logs are not read by decision code | F13 |
| Prompt injection in B (the narrator) | tools exposed to a model are read-only (`get_pull_request`, `list_check_runs`, `read_run_log`) and no tool can merge, dispatch or comment; the model's output is text the deterministic `Notifier` posts through a template; a read tool gets a token minted with read-only permissions, so a model that is confused cannot hold a write token | F18 |
| Echoing untrusted text so another consumer treats it as a record | comments contain no `<!--`; titles are rendered inert | F13 |
| Bot approves its own release | no Deployments permission; no operation; not a reviewer; egress test | F6 |
| The bot publishes code that was not in the version PR | `main` must still be `M`; other merges refused until dispatch (D5) | F9 |
| Stolen App private key | not in state or logs; Worker secret; key rotation is a manual step; blast radius: `Contents: write` items above, bounded by branch protection, no Workflows permission and the environment click; O8 | F12 |
| Stolen operator `gh` token | out of scope; it can authorise a merge today through `merge.sh` as well (O6) | |
| A stranger installs a public App | the installation allowlist drops the delivery before the Durable Object; tokens only for allowlisted installations (O2) | F15 |
| A repository's rules change under the bot | blob pin mismatch refuses (D2) | F10 |
| Cross-repository confusion | every key includes `owner/repo`; the installation token is narrowed to the one repository | F16 |

## Falsifiers

Each row names the gate (a test or a check, in step 2) and the negative control (the one change that must make it fail). "Fake GitHub" is an in-process implementation of the declared `GitHubApi` operations that records every request; it is not a mock of `decideMerge`.

| # | Falsifier | Gate | Control |
| --- | --- | --- | --- |
| F1 | A `pass` record by an account that is not an operator account, or whose marker is not the first line, or followed by a `changes` record for the same head, or held only by a dismissed review, or whose body changed after the first read, does not merge (V1, V2, V3, V8) | contract rows X01 to X04, X12 plus a fake-GitHub journey | remove the author check: the forged-record row merges and the test fails |
| F2 | After a pass on head `A`, a force-push to `B` never merges `B`; a push between decision and call makes GitHub cancel it | journey where the fake moves the head between decision and call; merge request must carry `sha=A` | drop `sha` from the request: the fake merges `B` and the test fails |
| F3 | Red, cancelled, timed-out or missing required checks do not merge, **including a red non-required check**; pending waits and merges after green | contract rows M07 to M11, M20, X05 to X08 | treat `CANCELLED` as green, or test only the required checks: rows M09 and M08 fail |
| F4 | The same delivery id twice, and two concurrent deliveries about one PR, produce exactly one merge request and one dispatch | fake-GitHub journey counting requests | remove the unique key on `rb_deliveries` or the `rb_actions` claim: two requests |
| F5 | A request with a missing, malformed, wrong-length or wrong signature is `401` and the Durable Object stub is never called; GitHub's vector (`757107ea...`) verifies | Worker test with the real `Mac` layer | verify over parsed-then-re-serialised JSON instead of raw bytes: a payload with unusual whitespace fails |
| F6 | The bot never sends a request outside a declared `(method, path)` table, in particular never `POST .../pending_deployments`, `POST .../deployment_protection_rule`, `POST /pulls`, `PUT/DELETE contents`, `.../git/refs`, `.../releases` | an **egress guard** in the HTTP client layer rejects any request not in the table, and an assertion across every journey test lists the requests the fake saw; the `GitHubApi` interface has no such operation | (1) add `approvePending` to the table: the table-versus-permissions test (table must be a subset of the permissions in "Permissions") fails; (2) make one service send an undeclared request (a `POST /pulls`): the guard test and the journey assertion fail |
| F7 | `decideDispatch` dispatches only for a merged version PR with a pass record on its final head, `main == M`, `checks` success on `M`, no release hold, mode from config, `ref=main`, no earlier ledger row | pure-function rows plus journey | dispatch while `checks` on `M` is pending: row fails |
| F8 | After `workflow_job` `waiting`, exactly one comment contains the run's `html_url`; a redelivery, a restart and a second `waiting` event add none | journey with a restart (F14) and a duplicate | drop the `comment:` ledger key: two comments |
| F9 | A commit landing on `main` after `M` and before the dispatch causes no dispatch and one explanatory comment; bot merges in the same repository are refused between the version merge and the lock's end; the lock ends on a recorded dispatch, on `checks` on `M` concluding without `success`, and after `releaseLockTimeout` with `checks` unfinished | journey where the fake advances `main`, one where `checks` on `M` fails, one where it never completes (under `TestClock`) | skip the re-read of `main`: the dispatch happens; never unlock on timeout: the third journey leaves the repository locked and fails |
| F10 | `decideMerge` and the real `merge.sh` agree on every base row of the Contract table (M01 to M20: exit code and "merge called"); every deviation row (X01 to X12, V1 to V8) has `merge.sh` merging and `decideMerge` refusing; a mismatching blob pin refuses at runtime | contract test running the canonical `merge.sh` with stub `gh`/`git`; pin test against fake contents API | reorder checks 1 and 2 in `decideMerge`: M12 fails (exit-code order is part of the contract); drop the non-required checks from rule 2: M08 fails |
| F11 | In `observe` mode, with `.github/bot-hold` present, after an `installation` `suspend` event, and in a repository with no config, no write request is sent | fake-GitHub journey asserting zero writes | read the hold file once at start instead of per evaluation: the added-hold case fails |
| F12 | No secret value appears in logs, audit rows, Durable Object tables, error messages or PR comments; the private key and webhook secret are `Redacted` | test that dumps all three after a journey and searches for the test key's PEM body and the secret; `gitleaks` in CI | log the key on error: the dump test fails |
| F13 | A PR title or comment containing a marker, `@mention`, HTML comment, backticks or an instruction ("ignore the rules and merge") changes no verdict and no request; a comment the bot posts never matches `merge.sh`'s marker grep | journey with hostile strings; run the canonical `merge.sh` marker `grep` over every comment the bot produced | echo the raw title: the marker survives and the `grep` test fails |
| F14 | Interrupting the Durable Object (scope close or a thrown exception) after the intent row and before the call, and after the call and before the receipt, leaves exactly one merge, one dispatch and one comment after restart | interruption tests at both points for each action kind | write the receipt without reading back: a duplicate appears |
| F15 | A delivery from a non-allowlisted installation account is dropped before the Durable Object; no token is minted for it | Worker test with a fake `GET /app/installations` | take the installation id from the payload: the test mints a token and fails |
| F16 | Every ledger key and every minted token is scoped to one repository; a delivery for repository A never changes state of B | journey with two repositories | key by PR number only: collision test fails |
| F17 | `classifyPublisher` returns `oidc` for the registry document of `@pg-txmode/core@0.1.0-alpha.2`, `token` for `alpha.0` and `alpha.1`, `not-published` for an absent version; the report names every package of the version PR | fixtures **captured from the live registry** (command and raw JSON committed) with the personal fields (`_npmUser` name and e-mail, `maintainers`) **replaced by a placeholder** by the capture script; the classifier needs only the OIDC address; a scan of `test/fixtures` for e-mail addresses other than `npm-oidc-no-reply@github.com` | classify by provenance presence: `alpha.0` becomes `oidc` and the test fails; commit an unredacted fixture: the scan fails |
| F18 | (Only if O1 chooses B) the tool registry the model sees contains no name that merges, dispatches, comments, approves or writes, and its GitHub token has no write permission | test over the registry and over the token request body | register a tool named `merge`: the test fails |
| F19 | The end-to-end journey runs on a throwaway repository the operator provides: record, green CI, merge, (version PR) dispatch, waiting comment with the run URL, the operator's own click, report | **live journey**, steps in "Operator steps"; the run directory with request log and PR links is attached to the step 2 PR | not applicable (a real observation) |
| F20 | The **API-to-fact mapping** of "Where rules 4 and 5 get their facts" gives the verdict that the git facts of the same repository state give: disjoint, overlapping, conflicting, `mergeable: null` (`Wait`), a 300-entry file list (`Refuse(Unknown)`), and a PR with a non-null `stack` | fixtures **captured from the real API on a throwaway repository** (each paired with the `git` facts of the same state, command and raw JSON committed, personal fields redacted) and replayed through the fact mapper; the capture script is re-run in the F19 live journey. If the account cannot create a native stack, that fixture is derived from the `2026-03-10` schema and says so | map `mergeable: null` to `true`: the `null` row merges and the test fails; read only the first 299 files: the truncated row fails |

## Constraints and values

- Correctness by construction: the rules are one function; the permission set, the endpoint table and the missing operations make "approve" and "edit files" unrepresentable as far as the bot's own code goes; GitHub-side limits are named where the permission cannot express it.
- Single source of truth: rules from `merge.sh` (tested, and refused on drift), configuration as data in the repository, facts from the API each time.
- Pure stays pure; services only for capabilities; one composition root per host; Schema at every boundary; native Effect (HTTP, crypto, SQL, Config, Schedule, DateTime, Redacted). No `node:crypto`, `fetch`, `process.env`, global timers.
- Private repository: names and lengths of credentials only, nowhere a value.
- Pin Effect `>=4.1.0`; treat `effect/crypto` and other `@stability unstable` modules as break-prone: pin the minor and list them in `allowedUnstableApis`.
- Fail closed: an unknown state, a decode failure, a drifted rule or a missing fact is a refusal, never a merge.

## Operator steps

None of these is done by this spec or its PR. No credential is created or read. Values never go into chat, files or logs; names and lengths only.

1. **Decide O1 to O8** (the lead resolves them in Revisions where it can; O1, O2, O3 are the operator's).
2. **Create the GitHub App** (GitHub, Settings, Developer settings, GitHub Apps, New), as account `phibkro`:
   - Name and homepage: operator's choice. Webhook: Active; URL set in step 6 (the Worker URL does not exist yet; the form may be saved with it inactive); secret: a freshly generated high-entropy random string (held in a 0600 file, never printed); SSL verification on.
   - Repository permissions exactly as in "Permissions": Metadata read; Pull requests **read**; Issues **write**; Contents **write**; Checks read; Commit statuses read; Actions **write**. Everything else "No access" (in particular Deployments, Workflows, Administration, Pull requests write).
   - Subscribe to the events in "Webhook events" (`pull_request_review`, `issue_comment`, `pull_request`, `check_run`, `status`, `workflow_job`, `workflow_run`; `installation` is automatic).
   - User authorization callback, device flow, "expire user tokens": off; the bot needs no user token.
   - "Where can this GitHub App be installed": **Any account** for O2 option 1, else "Only on this account".
   - Generate **one private key** and keep the downloaded `.pem` in a 0600 file.
3. **Install the App** on `phibkro` (select only `pg-txmode`, `pg-outbox`, `vektorprogrammet-reimagined`) and on `tsukuri-labs` (select only `tsukuri`, `foldkit-flow`; an organisation owner approves). Not "all repositories".
4. **Put two secrets on the Worker** (O3): `GITHUB_APP_PRIVATE_KEY` (the PEM) and `GITHUB_WEBHOOK_SECRET`, each from stdin, then delete the `.pem` file and the secret file. Report only the names and the byte lengths. Non-secret `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID` go in config.
5. **Deploy** the stack with Alchemy v2 using the operator's Cloudflare profile (`2.0.0-beta.84`, npm `latest` on 2026-10-30), which prints the Worker URL.
6. **Set the webhook URL** in the App's settings to `<Worker URL>/webhook/github`, then use "Recent Deliveries" and redeliver the `ping`: the response is `200`.
7. **Observe period**, then flip each repository to `act` with a config PR. Protect `main` in `vektorprogrammet-reimagined` first (O7).
8. Optional hardening (O8): tag ruleset on the four release repositories (only the operator may create or delete tags), branch-creation restriction.
9. **Live journey for F19**: a throwaway repository with a tiny `release.yml` copy and an `npm-release`-like environment whose required reviewer is the operator; install the App there for the test only, allowlist it in a test config, and remove both afterwards.

## Delivery

- Step 1 (this PR): this spec and the skeleton (`README.md`, `AGENTS.md`, `CLAUDE.md`, `STATE.md`, `LICENSE`, `.gitignore`). It opens as a spec-only PR by the lead's assignment; the projects-tier rule says a PR opens when its journey is built, so this is a declared exception and the Review rounds judge the plan.
- Step 2: the implementation against this spec, as a PR stacked on this one, with `verify-bot`, the `effect-house` overlay, the exception registry, the contract fixtures and the checks named here. Its Revisions entries record each change to this plan.
- Non-goals are listed in D12.

## Sources and verification

Verified on 2026-10-30 unless noted. "Command" entries were run for this spec.

| Claim | Source |
| --- | --- |
| Merge needs Contents: write, not Pull requests: write; dispatch needs Actions: write; approval needs Deployments: write; the other endpoint-to-permission rows | `github/docs` `src/github-apps/data/fpt-2022-11-28/server-to-server-permissions.json` (command: `jq` over it), and <https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps> |
| Required reviewers are up to 6 people or teams; `Prevent self-review` option | <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments> |
| `pending_deployments` approval is for required reviewers; apps review only their own custom rules; reviewer type `User` or `Team` | <https://docs.github.com/en/rest/actions/workflow-runs> |
| Review deployments is a click on the run | <https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments> |
| Merge endpoints, `sha`, `merge-async`, `bypass_rules` | <https://docs.github.com/en/rest/pulls/pulls> |
| Dispatch response in API `2026-03-10`: always `200`, `return_run_details` removed | `github/rest-api-description` `descriptions/api.github.com/CHANGELOG.md` (version `2026-03-10`) and the OpenAPI files `api.github.com.2022-11-28.json`, `api.github.com.2026-03-10.json` (command: `jq` over the dispatch operation of each); <https://docs.github.com/en/rest/actions/workflows>. The blog post <https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids> describes `2022-11-28` only |
| `workflow_job` action `waiting`; per-event permissions; delivery headers; 25 MB | <https://docs.github.com/en/webhooks/webhook-events-and-payloads> |
| HMAC-SHA256 `X-Hub-Signature-256`, constant-time compare, test vector | <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries> |
| 10 s response, no automatic redelivery, unique `X-GitHub-Delivery` | <https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries>, `.../best-practices-for-using-webhooks` |
| JWT claims and RS256; installation token one hour, `permissions` and `repositories` body, new token format | <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app>, `.../generating-an-installation-access-token-for-a-github-app` |
| Rate limits | <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api> |
| Private App installs only on the owner's account | <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private> |
| App-token events trigger workflows, `GITHUB_TOKEN` events do not | <https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow> |
| `merge.sh` logic identical in all five repositories; pins; branch protection; environments; settings | commands: `gh api repos/<r>/contents/.agents/skills/review-pr/merge.sh`, `sha256sum`, `/branches/main/protection`, `/environments`, `/actions/workflows`; local copies in `pg-outbox`, `reebeat` |
| Registry `_npmUser` OIDC versus token | command: `npm view @pg-txmode/core@<v> _npmUser`; `npm view @tsukuri/core@alpha _npmUser` |
| npm logs the OIDC outcome only at `verbose` | <https://github.com/npm/cli/blob/latest/lib/utils/oidc.js> (commit `9741b645b`, 2026-09-30); docs: <https://docs.npmjs.com/trusted-publishers> ("automatically detects OIDC environments ... before falling back to traditional tokens") |
| PiHarness: Lifecycle capability on a Durable Object, no tool approval, experimental, recovery rules, replay safety | <https://developers.cloudflare.com/agents/harnesses/pi/>, `.../extensions/`, <https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness> |
| `Lifecycle.install(host: DurableObject<Env>)` installs `fetch` and `alarm` | `agents@0.32.0` `dist/durable-object-lifecycle-DOI_bzCH.d.ts` (command: `npm pack`); peers `@earendil-works/pi-durable ~1.4.0`, `pi-ai ~1.4.0`; `pi-durable@1.4.0` is npm `latest` |
| Alchemy v2 Effect-native Durable Object and class-based async Durable Object | `alchemy@2.0.0-beta.84`, `@alchemy.run/cloudflare@2.0.0-beta.84` `src/Workers/DurableObject.ts` (command: `npm pack`); npm `latest` is `2.0.0-beta.84` |
| Durable Object alarms at-least-once, 6 retries; output gates; SQLite storage, PITR 30 days | <https://developers.cloudflare.com/durable-objects/api/alarms/>, `.../best-practices/rules-of-durable-objects/`, `.../api/sqlite-storage-api/` |
| `@effect/sql-sqlite-do@4.1.0` `storage` option | package source (command: `npm pack`) |
| `Mac.verify`, `Signature` (RSA PKCS#1 v1.5 SHA-256), `KeyFormat.pkcs1` import | `effect@4.1.0` `src/crypto/Mac.ts`, `Signature.ts`, `KeyFormat.ts` |
| `cf` cannot set a single secret; `--secrets-file`; Secrets Store is open beta | <https://developers.cloudflare.com/cf/llms-full.txt>, <https://developers.cloudflare.com/secrets-store/> |
| OptMem: repository, commit, `cover`, no licence | <https://github.com/VictorTaelin/OptMem> `@1fb164cf39028047781f72ac3bb1e5a691c1dcb0` (command: `gh api repos/VictorTaelin/OptMem --jq .license` is `null`; no `LICENSE` in the file list) |

Inferences left for step 2 to test: the `StatusContext` conclusion in `statusCheckRollup` (D3); the PKCS#1 key and modulus import (D10); `_npmUser` as a stable registry contract (report); that the API merge counts as a push for a push-restriction list; that GitHub rejects token mints for a suspended installation; whether Alchemy's Effect-native Durable Object and `Lifecycle.install` can share a class (O1); that `cf` has a Secrets Store command (O3); that the dispatched run's checkout is the commit at trigger time; that `merge-async` accepts a PR that edits `.github/workflows/*` when the App lacks the Workflows permission (documented as refused for pushes and the contents API, not settled for the merge API; the failure is safe, the poll says `failed`); that `mergeable` agrees with `git merge-tree --write-tree` in every case (F20 tests it on captured states); that `git diff --name-only` lists only the new path of a rename.

## Revisions

Entries are dated and never replace the text above; where an entry resolves an **Open** fork, the entry is the decision and the fork's text stays as the record of the options.

1. **2026-10-30, resolution of the open forks (the lead, relaying the operator).**
   - **O1: plain Durable Object in v1.** PiHarness becomes spec 0001, written when there is a concrete model job. The `Narrator` seam stays reserved (the `Notifier` accepts a message, so a narrator can later supply a paragraph). Consequences for this spec: D11's host shape is Alchemy's Effect-native `DurableObject` with its own `alarm` handler; the B column of the O1 table and falsifier **F18** do not apply to v1 and are not built (F18 returns with spec 0001); the Threat model row "Prompt injection in B" describes the constraint spec 0001 must meet.
   - **O2: option 1.** One App owned by `phibkro`, installable by any account, with an allowlist by numeric account id (`71797726` for `phibkro`, `349117663` for `tsukuri-labs`) checked in the Worker before the Durable Object and before any token mint (F15). "Operator steps" 2 sets "Where can this GitHub App be installed" to **Any account**.
   - **O6: a pass is trusted only from the operator account, numeric id `71797726`.** The record-author allowlist (deviation V1) holds that one id.
   - **O3, O4, O5, O8 accepted as recommended:** Worker secrets from stdin with Wrangler as a registered house exception until `cf` can set a single secret (O3); version PRs recognised by a declared title pattern, mode `publish` only (O4); the PR comment is the v1 notification (O5); tag and branch-creation rulesets are optional hardening (O8).
   - **Rollout:** observe mode is the default for all five repositories at deploy (a decision, not a fork).
   - **Licence:** `LICENSE` keeps the all-rights-reserved text.
   - **OptMem port (D12):** clean-room implementation from the described algorithm, or the author's written permission; no code is copied from `VictorTaelin/OptMem` while it has no licence file.
   - **O7 stays open** for the lead to raise with the operator; it does not block observe mode.
   - "Operator steps" 1 ("Decide O1 to O8") is superseded by this entry except for O7.
2. **2026-10-30, delivery.** The spec-only PR stays as it is, with the exception declared under "Delivery"; the implementation is a stacked PR against this spec, with its own Revisions entries. In step 2 `merge.sh` and `record-round.sh` are copied into `.agents/skills/review-pr/` **from `phibkro/pg-txmode`** (blobs `40d6be4d7897d56d369af7275e99e4926f933a02` and `646bb10606f1b6683908e8e0f0171ec611032f8b` at `d9b4142d`), changed only in the provenance header, so this repository's own PRs use the review loop that the bot's contract test pins.
3. **2026-10-30, round 1 review of `5c33160` (RevOutbox1: changes, four medium and nine low findings).** The spec was edited in place where its text was wrong or incomplete, because the earlier text contradicted a verified fact; each change is listed here with its kind. **Corrections of a wrong claim:** D6 said to send `return_run_details: true` with API version `2026-03-10`; that parameter exists only in `2022-11-28` and was removed in `2026-03-10`, where the dispatch endpoint always returns `200` (changelog and both OpenAPI files read); D6 now pins one API version on every call and treats anything but a decoded `200` as failure, and the Sources row and the blog-post citation are fixed. D7 and "Authority" said the bot merges only `H`; under `merge-async` a PR in a native stack merges its open downstack PRs, so the claim holds only outside a stack. V4 as worded could have loosened rule 2; it is now added to rule 2 and rule 2 holds for every check. "Decided by" no longer cites a private path. **Plan additions:** "Where rules 4 and 5 get their facts at runtime" (fields `behind_by`, `mergeable` with `null` as `Wait`, compare file lists with a fail-closed 300-entry limit, rename names) and falsifier **F20** for the API mapping, which the git-based contract test cannot prove; V7 (`stack`, `Refuse(Stacked)`) and V8 (record body pinned at first read); V3 gains its ordering key (round number, then timestamp) and ignores `DISMISSED` reviews; V4 requires the `github-actions` app for required checks; the **Contract table** (M01 to M20, X01 to X12) is now in the spec and F1, F3, F10 cite its rows (the earlier "R06 to R08" had no table); the release lock gains two unlocks (`checks` on `M` not `success`, and `releaseLockTimeout`, default 30 minutes) and F9 tests them; the merge poll holds the write token (D10); `check-record.sh` is pinned (tsukuri); F6 gains a control for the egress guard itself; F17 fixtures are redacted by the capture script and scanned for e-mail addresses; O6 states the record-edit policy; the inference list gains the workflows-edit merge case, the `mergeable` versus `merge-tree` agreement and the rename listing. D3's "six declared places" is now eight.
4. **2026-10-30, the spec was merged first; this PR is its implementation.** The spec-only PR (#1) went through review round 1 and was merged as `2873c5b` before any code was written, which is the exception that "Delivery" declares. This implementation PR starts from that `main`, so the text above is the merged text and every change to it is an entry here. The review scripts are copied as Revisions 2 says (from `phibkro/pg-txmode` at `23be53c0c66a129540350697253b5c19abde3171`, whose two blobs are the ones Revisions 2 names).
5. **2026-10-30, what the build taught.** Each item changes or sharpens the text above; none widens the bot's authority.
   - **Host shape (changes D11).** The Durable Object is a plain `DurableObject` class (`apps/bot/src/worker.ts`) with one `ManagedRuntime` for the object and one for the Worker, not Alchemy's Effect-native Durable Object. Reasons: a local workerd smoke test of the whole webhook path needs no Alchemy tooling with a plain class (it bundles with `bun build` and runs in Miniflare), and PiHarness (spec 0001) mounts with `Lifecycle.install(this)` on a real `cloudflare:workers` class. The cost is a registered exception, EX-0001 (`tools/quality/exceptions.json`): the Workers ABI is Promise-based, so that one file turns off the language service's `asyncFunction` check and three Oxlint rules. The object answers `GET /audit` on its own `fetch` (reachable only through the binding; the Worker forwards nothing to it), which the smoke test and the operator use to read the audit log.
   - **Contract table and F20 are met in part.** M01 to M20 and X01 to X12 run the real `merge.sh` against `decideMerge` (`packages/rules/test/contract.test.ts`, with a stub `gh` serving each row's JSON through the script's own `--jq` filters and real `git`). F20 holds for the mapping of API fields to facts against a git-backed model of GitHub's `mergeable` and `compare` (`apiMapping.test.ts`) and against the real response shapes captured from the live API by `tools/capture/capture.sh`; the agreement of GitHub's own `mergeable` with `git merge-tree` beyond that model is part of the live journey (F19, on a throwaway repository).
   - **A pull request's `stack` is optional.** The real API omits the key when a PR is not stacked (captured: `pull-merged.json`); the decoder takes it as optional, and V7 reads its absence as "not stacked".
   - **The combined status is `pending` with no statuses.** The captured `status.json` of a repository with check runs only has `state: pending` and zero statuses, so the bot reads the individual contexts and check runs (M20), never the combined `state`.
   - **`_npmUser` carries the trusted publisher.** The captured npm version documents for `0.1.0-alpha.0`, `.1` and `.2` show `_npmUser` as `GitHub Actions <npm-oidc-no-reply@github.com>` for the OIDC publish and a person's account for token publishes. The Report's "OIDC or token" line uses it as extra evidence next to provenance (INFERENCE that it is a stable registry contract: seen on three versions).
   - **`check-record.sh` is not copied.** `pg-txmode` has none (only `tsukuri` does); the bot compares the blob hash pinned in `config.ts` and never runs a script from a target repository.
   - **The ledger has no migrator.** The `rb_*` tables are created with `CREATE TABLE IF NOT EXISTS` when the object starts; `rb_audit` has triggers that refuse `UPDATE` and `DELETE`. A schema change is a spec Revision until a migrator exists.
   - **A pending version-PR lock holds the other pull requests.** While a release lock for a repository is held (D7, F9), the bot merges no other pull request there (`lockedByRelease`); it unlocks by the rules F9 lists.
   - **Delivery admission marks the item dirty.** A delivery that arrives while an item is being evaluated sets `dirty`, so the evaluation runs again; an internal re-enqueue only sets `retry_at`. An earlier draft re-enqueued without that distinction and rescheduled itself without end; a test (F4) pins it. An alarm runs at most 50 batches.
   - **Diagnostics.** `preferEffectArray`, `preferEffectString` and `preferEffectRecord` are `off` in the two Effect `tsconfig.json` files (the code that trips them is plain-data code governed by the Oxlint rules); `.agents/skills/effect-house/SKILL.md` says so. The Oxlint relaxations are listed with reasons in the root `vite.config.ts`.
   - **The workerd smoke runs under the app's tests** (`apps/bot/smoke/workerd.test.ts`, `bun run smoke`), with a key and a secret generated for the run and GitHub served from the captured fixtures.
   - **Operator checklist.** `docs/operator-checklist.md` is generated from `packages/rules/src/app.ts` and `config.ts` (`bun run docs:gen`); a test and `check:docs` fail when it differs, so the permissions, events, secret names and installs in it cannot drift from the code. "Operator steps" above stays the plan; the checklist is its executable form.
   - **Deploy definition.** `apps/bot/alchemy.run.ts` (Alchemy `2.0.0-beta.84`) declares one Worker and the Durable Object binding and no secret; it type-checks and has never been deployed (INFERENCE: its runtime behaviour, and that a deploy keeps out-of-band Worker secrets).
6. **2026-10-30, round 1 review of `6abc1a3` (RevOutbox4: changes, two medium findings and five lows).** Each item below changes the code or the claim; none widens the bot's authority.
   - **F11: the `act` gate is where the write happens.** `mergeIt` and `dispatchIt` each refuse to run unless the repository's `mode` is `act`; the caller's `acting` fact and the `NotActing` verdict stay, so an `observe` repository still gets an audit row that says why. A journey now has a **merged version PR in an `observe` repository**: no write, no comment, and a `dispatch-verdict` row `NotActing`. Controls run: the caller mutated to `acting: true` alone fails that test (the gate held, so the failure is the verdict row); the caller mutated and the gate removed fails it on the write; the gate removed alone passes, because the verdict still stops the call before it, so the gate is defence in depth and has no control of its own.
   - **F14 is built at both points for each action kind.** The fake GitHub gets a `before*` and an `after*` eviction hook for merge, dispatch and comment. New tests: an eviction after the intent and before the call, for the merge, the dispatch and the comment; and after the comment was posted and before its receipt (the read-back). Controls run: a receipt written before the merge call fails the before-merge test; the comment read-back disabled fails the after-comment test.
   - **The merge receipt and the release lock are one transaction** (`ReleaseLedger.recordMerge`, replacing `recordReceipt` plus `setLock` in `mergeIt`; `setLock` is removed). An eviction cannot leave the receipt without the lock. A ledger test forces the lock write to fail with a trigger and asserts the receipt rolled back; the control (no transaction) fails it.
   - **A refused merge is final for that head.** A `400` (not mergeable now) and a failed poll close the key `merge:<repo>#<n>@<head>` with a `rejected:` or `failed:` receipt and post one comment; nothing asks GitHub again about the same head, and a new head is a new key. Whether a `400` can be transient is INFERENCE (not tested against the live API); if it can, the operator's answer is a new commit. A journey pins the policy (one call, one comment however often the PR is re-told).
   - **The operator id is pinned in the code path:** `rules.test.ts` asserts `operatorIds` is `[71797726]`, the allowlist is the two account ids, and `passRecordFor` trusts exactly that author. Before, only the checklist drift test failed when the id changed.
   - **EX-0001 is narrower.** The file-level `oxlint-disable` of six rules is replaced by one `oxlint-disable-next-line` per site for the two rules that describe the Promise ABI (`effect/no-native-promise-control-flow` on four methods, `effect/no-premature-execution` on the two `ManagedRuntime.make` calls). The global `Cloudflare.Env` augmentation, which needed the other four, is gone: the Worker's `fetch` takes `env` as a parameter and builds its ingress runtime once per `env`. The exception text no longer leans on spec 0001 as a reason.
   - **The contract fixture is `vektorprogrammet-reimagined`'s `merge.sh`, the origin.** `packages/rules/test/fixtures/merge.sh` is that repository's blob (`8d6d6283…`, its pin in `config.ts`). The vendored `.agents/skills/review-pr/merge.sh` is `pg-txmode`'s copy (blob `0d972e66…` here, `40d6be4d…` there; the two differ by the provenance line each carries), which in turn copied the origin. Revisions 4 and the PR body said "copied from pg-txmode" of the fixture, which was wrong; `PROVENANCE.md` now says which is which. The five repositories' `merge.sh` have the same body (checked in step 2 after removing the provenance lines), so the contract test running the origin covers the rules every pin names.
   - The `checks` failure on the PR is the account's GitHub Actions billing, not code (the lead is raising it with the operator).
