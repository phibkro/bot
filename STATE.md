# State

Lifecycle: spec

Now:

Spec 0000 ([`docs/specs/0000-release-bot-v1.md`](docs/specs/0000-release-bot-v1.md)) is written and its PR is open: the release bot's journey, authority, permissions, rules, Durable Object state, threat model and falsifiers. This PR holds the spec and the repository skeleton only. Nothing is built, no GitHub App exists, no credential has been created or read.

Next:

- Review of the spec PR (a fresh reviewer, assigned by the lead).
- Open forks resolved on 2026-10-30 (spec 0000, Revisions 1): O1 plain Durable Object, PiHarness is spec 0001; O2 one App owned by `phibkro`, installable by any account, account-id allowlist; O6 a pass is trusted only from account id 71797726; O3, O4, O5, O8 as recommended. **O7** (branch protection on `vektorprogrammet-reimagined`) stays with the lead and the operator.
- Step 2: the implementation against the spec as a stacked PR (rules package with the contract test against `merge.sh`, webhook ingress, Durable Object, Alchemy stack, `verify-bot`, the `effect-house` overlay and exception registry, the review scripts copied from `phibkro/pg-txmode`).

Blocked:

- The operator's manual steps ("Operator steps" in the spec): create the GitHub App, install it on `phibkro` and `tsukuri-labs`, set the two Worker secrets, set the webhook URL. None can be done by an agent.
- Step 2's live journey (falsifier F19) needs the operator's throwaway repository and the installed App.

Observations to fix on touch:

- `phibkro/vektorprogrammet-reimagined` has no branch protection and its `main` shows a failed `checks` run (read 2026-10-30).
- `merge.sh` accepts a pass marker from any commenter on a public repository, and merges when no check has registered yet (spec 0000, D3, V1 and V4). The bot tightens both; the scripts themselves are unchanged.
