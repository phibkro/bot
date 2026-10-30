# State

Lifecycle: build

Now:

Spec 0000 ([`docs/specs/0000-release-bot-v1.md`](docs/specs/0000-release-bot-v1.md)) was reviewed and merged first (`2873c5b`). Its implementation is built and open as a stacked PR: the pure rules with the contract test against the real `merge.sh`, the GitHub App auth and API client with an egress guard, the SQLite ledger, the webhook ingress, the Durable Object host with a `Narrator` seam, the Alchemy deploy definition (observe mode for all five repositories), the generated operator checklist, and a local workerd smoke of the webhook path. Nothing is deployed, no GitHub App exists, no credential has been created or read.

Next:

- Review of the implementation PR (a fresh reviewer, assigned by the lead).
- The operator follows [`docs/operator-checklist.md`](docs/operator-checklist.md): create the App, install it, deploy, put the two Worker secrets, set the webhook URL, redeliver the ping.
- Observe period, then switch repositories to `act` one at a time (a PR to `packages/rules/src/config.ts`).
- Spec 0001 (PiHarness behind the `Narrator` seam) when there is a concrete model job.

Blocked:

- The operator's manual steps (the checklist): none can be done by an agent.
- The live journey (falsifier F19) and the real-API capture for F20 need the operator's throwaway repository and the installed App.
- **O7:** branch protection is a precondition for `act` mode in each repository; check it before a repository's `mode` becomes `act`.

Observations to fix on touch:

- `merge.sh` accepts a pass marker from any commenter on a public repository, and merges when no check has registered yet (spec 0000, D3, V1 and V4). The bot tightens both; the scripts themselves are unchanged.
