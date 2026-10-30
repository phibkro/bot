import {
  appEvents,
  appPermissions,
  forbiddenPermissions,
  githubApiVersion,
  secretNames,
  variableNames,
} from "./app.ts";
import type { AppEvent, PermissionName } from "./app.ts";
import {
  allowedAccounts,
  operatorAccount,
  principalName,
  repositories,
} from "./config.ts";

/**
 * The operator checklist (spec 0000, "Operator steps"), generated from the App registration data and the repository
 * declaration: the permissions, the events, the secret names and the installs cannot drift from what the code enforces
 * (`bun packages/rules/scripts/checklist.ts --check`, and `test/checklist.test.ts`). It contains no secret value and no
 * credential; nothing here is done by an agent.
 */

const uiPermission: Readonly<Record<PermissionName, string>> = {
  actions: "Actions",
  checks: "Checks",
  contents: "Contents",
  issues: "Issues",
  metadata: "Metadata",
  pull_requests: "Pull requests",
  statuses: "Commit statuses",
};

const uiEvent = {
  check_run: "Check run",
  issue_comment: "Issue comment",
  pull_request: "Pull request",
  pull_request_review: "Pull request review",
  status: "Status",
  workflow_job: "Workflow job",
  workflow_run: "Workflow run",
} as const satisfies Readonly<Record<AppEvent, string>>;

const level = (value: "read" | "write"): string =>
  value === "write" ? "Read and write" : "Read-only";

const permissionNames: readonly PermissionName[] = [
  "metadata",
  "pull_requests",
  "issues",
  "contents",
  "checks",
  "statuses",
  "actions",
];

const permissionRows = permissionNames
  .map(
    (name) =>
      `| ${uiPermission[name]} | ${level(appPermissions[name].level)} | ${appPermissions[name].reason} |`
  )
  .join("\n");

const installRows = allowedAccounts
  .map((account) => {
    const names = repositories
      .filter((repo) => repo.account.id === account.id)
      .map((repo) => `\`${repo.fullName.split("/")[1] ?? ""}\``);

    return `| \`${account.login}\` (id ${account.id}) | ${names.join(", ")} |`;
  })
  .join("\n");

export const renderChecklist =
  (): string => `# Operator checklist: the release bot

Generated from \`packages/rules/src/app.ts\` and \`config.ts\` by \`bun packages/rules/scripts/checklist.ts\`; do not edit by hand
(\`--check\` and a test fail on a difference). Spec: [\`docs/specs/0000-release-bot-v1.md\`](specs/0000-release-bot-v1.md), "Operator steps".

**Nothing here is done by an agent.** No step puts a credential in a file that is committed, in chat, or in a log; the two secret
values below are typed or piped by you, and their names and lengths are all that is ever reported. Stop at any step that does not
look as described.

## 1. Create the GitHub App (as \`${operatorAccount.login}\`)

GitHub, Settings, Developer settings, GitHub Apps, New GitHub App.

| Field | Value |
| --- | --- |
| GitHub App name, Homepage URL | your choice (the Homepage URL may be the repository's address) |
| Identifying and authorizing users | leave "Request user authorization (OAuth) during installation", "Enable Device Flow" and "Expire user authorization tokens" **off**: the bot needs no user token |
| Webhook | **Active**. URL: leave a placeholder now, set it in step 5. Secret: a freshly generated random string (at least 32 bytes), kept in a 0600 file for step 4. SSL verification: **Enable** |
| Where can this GitHub App be installed? | **Any account** (spec 0000, O2: the bot drops every installation whose account id is not \`${allowedAccounts.map((account) => account.id).join("` or `")}\`, before any work) |

**Repository permissions** (everything not listed stays "No access"; the \`Pull requests\` level is deliberately read-only):

| Permission | Access | Why |
| --- | --- | --- |
${permissionRows}

Never grant: ${forbiddenPermissions.map((name) => `\`${name}\``).join(", ")}, and never \`Pull requests: Read and write\` (it would let the bot open PRs and approve).

**Subscribe to events:** ${appEvents.map((event) => `**${uiEvent[event]}**`).join(", ")}. ("Installation" is sent to every App automatically.)

Create the App. Note the **App ID** and the **Client ID** (not secrets). Then "Generate a private key": a \`.pem\` file is downloaded; move it
to a 0600 file (\`chmod 600\`), do not open it, do not paste it anywhere.

## 2. Install the App

Only on the selected repositories, never "All repositories". GitHub, the App's page, Install:

| Account | Repositories |
| --- | --- |
${installRows}

(An organisation owner approves the installation on \`tsukuri-labs\`.)

## 3. Deploy

With the operator's Cloudflare profile for Alchemy v2 (\`2.0.0-beta.84\`):

\`\`\`sh
${variableNames[0]}=<App ID> ${variableNames[1]}=<Client ID> devenv shell -- bun alchemy deploy
\`\`\`

The stack declares one Worker and one SQLite-backed Durable Object class (\`ReleaseBot\`; the object's name is \`${principalName}\`) and prints
the Worker's URL (\`https://<worker>.<subdomain>.workers.dev\`). It declares **no secret**: the values below never enter Alchemy state.

## 4. Put the two secrets on the Worker (names only: ${secretNames.map((name) => `\`${name}\``).join(", ")})

From stdin, never as an argument. \`cf\` cannot set a single secret yet (Cloudflare's own documentation), so this step uses Wrangler as a
recorded house exception (spec 0000, O3), retired when \`cf\` can do it:

\`\`\`sh
wrangler secret put ${secretNames[0]} --name <WORKER_NAME> < /path/to/the-private-key.pem
wrangler secret put ${secretNames[1]} --name <WORKER_NAME> < /path/to/the-webhook-secret-file
wrangler secret list --name <WORKER_NAME>     # prints the names: ${secretNames.join(", ")}
\`\`\`

Then delete both files (keep the key in your password manager). After **every** later \`alchemy deploy\`, run \`wrangler secret list\` again: that a deploy keeps
out-of-band secrets is unverified (spec 0000, inference list); if a name is missing, put it again.

## 5. Point the App at the Worker

App settings, Webhook URL: \`<Worker URL>/webhook/github\`. Then "Advanced", "Recent Deliveries": redeliver the \`ping\`: the response is **200**
(\`pong\`). A \`401\` means the two webhook secrets differ; a missing delivery means the URL is wrong.

## 6. Observe, then act

Every repository starts in \`observe\` mode: the bot decides and writes its verdicts to its audit log and writes nothing to GitHub. Compare its
verdicts with your \`merge.sh\` runs for as long as you choose, then switch one repository at a time with a PR that changes \`mode\` in
\`packages/rules/src/config.ts\` to \`act\`. Before \`phibkro/vektorprogrammet-reimagined\` goes to \`act\`, protect its \`main\` (required check \`checks\`): today nothing but the bot's rules would stand between a pass record and the merge there.

## 7. The live journey (falsifier F19)

On a throwaway repository, with a \`release.yml\` that has the same \`mode\` input and an \`npm-release\`-like environment whose required reviewer is you:
install the App there for the test only, add it to a test configuration, and run: record a pass, green CI, the merge, a version PR, the dispatch, the
approval comment with the run URL, **your own click on "Review deployments"**, the report. Remove the installation and the configuration afterwards.
Capture the API states of \`tools/capture/capture.sh\` on that repository for F20.

## Kill switches (nothing to install)

| Switch | Effect |
| --- | --- |
| \`.github/bot-hold\` on a repository's default branch | every verdict for it is \`Refuse(Held)\` until the file is removed |
| \`mode: "observe"\` in \`config.ts\` | no write, durable in code |
| Suspend or uninstall the App (GitHub, Settings, Installations) | the \`installation\` event stops every action until unsuspended |
| Delete the App's private key, or delete the Worker | the bot cannot mint a token at all |

API version sent on every request: \`${githubApiVersion}\`.
`;
