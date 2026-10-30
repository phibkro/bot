# Provenance

Every file copied or adapted from another repository carries a header naming its source. This file is the index, with the deviations.

## From `phibkro/pg-txmode` @ `23be53c0c66a129540350697253b5c19abde3171`

| Here | Source | Deviation |
| --- | --- | --- |
| `.agents/skills/review-pr/merge.sh` | `.agents/skills/review-pr/merge.sh` | line 2 only (the provenance line); the body is byte-identical. Its blob hash, minus that line, is the pin in `packages/rules/src/config.ts` that the bot compares against each repository's copy (spec 0000, D2) |
| `.agents/skills/review-pr/record-round.sh` | `.agents/skills/review-pr/record-round.sh` | line 2 only |
| `packages/rules/test/fixtures/merge.sh` | **`phibkro/vektorprogrammet-reimagined`**, the origin (blob `8d6d628300c739067e2bf8f36e2f27450ac22f17`, its pin in `config.ts`), not pg-txmode's copy | none: no provenance line; the contract test runs this exact file (sha256 `3819dd69…2248236`). The vendored `.agents/skills/review-pr/merge.sh` is pg-txmode's copy of the same body |
| `tools/quality/exceptions.ts`, `checkExceptions.ts`, `test/*`, `vite.config.ts`, `tsconfig.json`, `package.json` | `tools/quality/*` | `exceptions.ts`: the directive pattern also matches the Effect language service's own suppression comments (EX-0001 uses one) |
| `tools/quality/exceptions.json` | the registry format | the entries are this repository's: EX-0001 |
| `.github/workflows/checks.yml` | `.github/workflows/checks.yml` | steps with no counterpart here are dropped (release staging, knip, copy-paste detection); `Operator checklist` is added |
| `vite.config.ts` | `vite.config.ts` | the Effect groups name this repository's packages; each relaxation is listed with its reason in the file |
| `packages/service/tsconfig.json`, `apps/bot/tsconfig.json` | `packages/effect/tsconfig.json` | `allowedUnstableApis` lists the unstable modules this code uses; `preferEffectArray`, `preferEffectString` and `preferEffectRecord` are `off` (see `.agents/skills/effect-house/SKILL.md`) |

**`check-record.sh` is not copied.** The lead's brief expected `check-record.sh` in `pg-txmode`; it has none (only `tsukuri` has one, pinned in `packages/rules/src/config.ts` as the blob `5c3bae6d28cd32e79ecdf54074c5c1953ff0d1c9` that the bot checks for drift). The bot never runs a script from a target repository, so it needs only the pin.

## Not copied

**OptMem** (Taelin's memory design, in the operator's decision log) is not used in spec 0000: the bot's state is the ledger in `ReleaseLedger.ts`, designed here from the spec. Using the design in a later spec needs a clean-room implementation or the author's permission (spec 0000, O5).

## Captured, not copied

`packages/service/test/fixtures/github/*` and `npm/*` are responses captured by `tools/capture/capture.sh` from the public API of the repositories named in `COMMANDS.txt`, with personal fields (e-mail addresses) replaced by `redacted@example.invalid`. No credential is in them.
