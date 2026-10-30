# Operator checklist: the release bot

Generated from `packages/rules/src/app.ts` and `config.ts` by `bun packages/rules/scripts/checklist.ts`; do not edit by hand
(`--check` and a test fail on a difference). Spec: [`docs/specs/0000-release-bot-v1.md`](specs/0000-release-bot-v1.md), "Operator steps".

**Nothing here is done by an agent.** No step puts a credential in a file that is committed, in chat, or in a log; the two secret
values below are typed or piped by you, and their names and lengths are all that is ever reported. Stop at any step that does not
look as described.

## 1. Create the GitHub App (as `phibkro`)

GitHub, Settings, Developer settings, GitHub Apps, New GitHub App.

| Field | Value |
| --- | --- |
| GitHub App name, Homepage URL | your choice (the Homepage URL may be the repository's address) |
| Identifying and authorizing users | leave "Request user authorization (OAuth) during installation", "Enable Device Flow" and "Expire user authorization tokens" **off**: the bot needs no user token |
| Webhook | **Active**. URL: leave a placeholder now, set it in step 5. Secret: a freshly generated random string (at least 32 bytes), kept in a 0600 file for step 4. SSL verification: **Enable** |
| Where can this GitHub App be installed? | **Any account** (spec 0000, O2: the bot drops every installation whose account id is not `71797726` or `349117663`, before any work) |

**Repository permissions** (everything not listed stays "No access"; the `Pull requests` level is deliberately read-only):

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read-only | mandatory for every GitHub App |
| Pull requests | Read-only | read PRs, reviews and files; the pull_request and pull_request_review events (not write: it would open PRs and approve) |
| Issues | Read and write | read and create PR comments; the issue_comment event needs Issues read |
| Contents | Read and write | the merge (PUT .../merge-async and its poll list only Contents: write); reads of compare, contents and commits |
| Checks | Read-only | read check runs of a head; the check_run event |
| Commit statuses | Read-only | read commit statuses; the status event |
| Actions | Read and write | dispatch release.yml; read runs, jobs and logs; the workflow_run and workflow_job events |

Never grant: `deployments`, `environments`, `workflows`, `administration`, `secrets`, `variables`, `members`, and never `Pull requests: Read and write` (it would let the bot open PRs and approve).

**Subscribe to events:** **Pull request review**, **Issue comment**, **Pull request**, **Check run**, **Status**, **Workflow job**, **Workflow run**. ("Installation" is sent to every App automatically.)

Create the App. Note the **App ID** and the **Client ID** (not secrets). Then "Generate a private key": a `.pem` file is downloaded; move it
to a 0600 file (`chmod 600`), do not open it, do not paste it anywhere.

## 2. Install the App

Only on the selected repositories, never "All repositories". GitHub, the App's page, Install:

| Account | Repositories |
| --- | --- |
| `phibkro` (id 71797726) | `pg-txmode`, `pg-outbox`, `vektorprogrammet-reimagined` |
| `tsukuri-labs` (id 349117663) | `tsukuri`, `foldkit-flow` |

(An organisation owner approves the installation on `tsukuri-labs`.)

## 3. Deploy

With the operator's Cloudflare profile for Alchemy v2 (`2.0.0-beta.84`):

```sh
GITHUB_APP_ID=<App ID> GITHUB_APP_CLIENT_ID=<Client ID> devenv shell -- bun alchemy deploy
```

The stack declares one Worker and one SQLite-backed Durable Object class (`ReleaseBot`; the object's name is `operator`) and prints
the Worker's URL (`https://<worker>.<subdomain>.workers.dev`). It declares **no secret**: the values below never enter Alchemy state.

## 4. Put the two secrets on the Worker (names only: `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`)

From stdin, never as an argument. `cf` cannot set a single secret yet (Cloudflare's own documentation), so this step uses Wrangler as a
recorded house exception (spec 0000, O3), retired when `cf` can do it:

```sh
wrangler secret put GITHUB_APP_PRIVATE_KEY --name <WORKER_NAME> < /path/to/the-private-key.pem
wrangler secret put GITHUB_WEBHOOK_SECRET --name <WORKER_NAME> < /path/to/the-webhook-secret-file
wrangler secret list --name <WORKER_NAME>     # prints the names: GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET
```

Then delete both files (keep the key in your password manager). After **every** later `alchemy deploy`, run `wrangler secret list` again: that a deploy keeps
out-of-band secrets is unverified (spec 0000, inference list); if a name is missing, put it again.

## 5. Point the App at the Worker

App settings, Webhook URL: `<Worker URL>/webhook/github`. Then "Advanced", "Recent Deliveries": redeliver the `ping`: the response is **200**
(`pong`). A `401` means the two webhook secrets differ; a missing delivery means the URL is wrong.

## 6. Observe, then act

Every repository starts in `observe` mode: the bot decides and writes its verdicts to its audit log and writes nothing to GitHub. Compare its
verdicts with your `merge.sh` runs for as long as you choose, then switch one repository at a time with a PR that changes `mode` in
`packages/rules/src/config.ts` to `act`. Before a repository goes to `act`, protect its `main` (required check `checks`) if it is not: without that, only the bot's rules stand between a pass record and the merge.

## 7. The live journey (falsifier F19)

On a throwaway repository, with a `release.yml` that has the same `mode` input and an `npm-release`-like environment whose required reviewer is you:
install the App there for the test only, add it to a test configuration, and run: record a pass, green CI, the merge, a version PR, the dispatch, the
approval comment with the run URL, **your own click on "Review deployments"**, the report. Remove the installation and the configuration afterwards.
Capture the API states of `tools/capture/capture.sh` on that repository for F20.

## Kill switches (nothing to install)

| Switch | Effect |
| --- | --- |
| `.github/bot-hold` on a repository's default branch | every verdict for it is `Refuse(Held)` until the file is removed |
| `mode: "observe"` in `config.ts` | no write, durable in code |
| Suspend or uninstall the App (GitHub, Settings, Installations) | the `installation` event stops every action until unsuspended |
| Delete the App's private key, or delete the Worker | the bot cannot mint a token at all |

API version sent on every request: `2026-03-10`.
