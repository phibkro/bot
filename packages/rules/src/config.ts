import type { ReleaseMode } from "./dispatch.ts";

/**
 * The bot's configuration as data (spec 0000, D1, D2, O2, O6, Revisions 1): who may record a pass, which accounts may install
 * the App, and per repository the rollout mode, the required checks, the pinned rule scripts and the release block.
 * A change here is a PR: the allowlists are code, so a stranger's installation changes nothing.
 */

export interface Account {
  readonly login: string;
  /** Numeric id: a login can be renamed and reclaimed, an id cannot. */
  readonly id: number;
}

export interface Pins {
  /** Git blob sha of `.agents/skills/review-pr/merge.sh` on the default branch. */
  readonly mergeSh: string;
  /** Git blob sha of `.agents/skills/review-pr/record-round.sh`. */
  readonly recordRound: string;
  /** Git blob sha of `.agents/skills/review-pr/check-record.sh`, when `record-round.sh` calls it. */
  readonly checkRecord?: string;
}

export interface ReleaseConfig {
  readonly workflow: string;
  readonly modes: readonly ReleaseMode[];
  readonly versionTitlePrefix: string;
  /** How long other merges wait for the dispatch after a version PR merged (spec 0000, D5). */
  readonly lockTimeoutMs: number;
}

export interface RepositoryConfig {
  readonly fullName: string;
  readonly account: Account;
  readonly defaultBranch: string;
  /** `observe`: decide and log, write nothing. `act`: merge and dispatch. Default for all five at deploy: `observe`. */
  readonly mode: "observe" | "act";
  readonly requiredChecks: readonly string[];
  readonly pins: Pins;
  readonly release?: ReleaseConfig;
}

export const operatorAccount: Account = { id: 71_797_726, login: "phibkro" };
export const tsukuriLabs: Account = { id: 349_117_663, login: "tsukuri-labs" };

/** Accounts whose installations the Worker accepts (O2): checked before the Durable Object and before any token is minted. */
export const allowedAccounts: readonly Account[] = [
  operatorAccount,
  tsukuriLabs,
];

/** Accounts whose `pass` record counts (O6, V1): the operator, by numeric id. */
export const operatorIds: readonly number[] = [operatorAccount.id];

/** The name of the one Durable Object (one per principal). */
export const principalName = "operator";

const release: ReleaseConfig = {
  lockTimeoutMs: 30 * 60 * 1000,
  modes: ["publish"],
  versionTitlePrefix: "chore(release): version packages",
  workflow: "release.yml",
};

/** Blob shas observed 2026-10-30 (spec 0000, D2). */
export const repositories: readonly RepositoryConfig[] = [
  {
    account: tsukuriLabs,
    defaultBranch: "main",
    fullName: "tsukuri-labs/tsukuri",
    mode: "observe",
    pins: {
      checkRecord: "5c3bae6d28cd32e79ecdf54074c5c1953ff0d1c9",
      mergeSh: "be57b18bfb1782e1277a39468f8d54437a41707f",
      recordRound: "ba7125c524f9e8820027dc911859191cab799de7",
    },
    release,
    requiredChecks: ["checks"],
  },
  {
    account: tsukuriLabs,
    defaultBranch: "main",
    fullName: "tsukuri-labs/foldkit-flow",
    mode: "observe",
    pins: {
      mergeSh: "be57b18bfb1782e1277a39468f8d54437a41707f",
      recordRound: "e58524f8ba480d93e2db8d6ad869223d6a4a30f1",
    },
    release,
    requiredChecks: ["checks"],
  },
  {
    account: operatorAccount,
    defaultBranch: "main",
    fullName: "phibkro/pg-txmode",
    mode: "observe",
    pins: {
      mergeSh: "40d6be4d7897d56d369af7275e99e4926f933a02",
      recordRound: "646bb10606f1b6683908e8e0f0171ec611032f8b",
    },
    release,
    requiredChecks: ["checks"],
  },
  {
    account: operatorAccount,
    defaultBranch: "main",
    fullName: "phibkro/pg-outbox",
    mode: "observe",
    pins: {
      mergeSh: "40d6be4d7897d56d369af7275e99e4926f933a02",
      recordRound: "646bb10606f1b6683908e8e0f0171ec611032f8b",
    },
    release,
    requiredChecks: ["checks"],
  },
  {
    account: operatorAccount,
    defaultBranch: "main",
    fullName: "phibkro/vektorprogrammet-reimagined",
    mode: "observe",
    pins: {
      mergeSh: "8d6d628300c739067e2bf8f36e2f27450ac22f17",
      recordRound: "de76d08e4b20c1b15a39d06f55897b9cfe91eb97",
    },
    requiredChecks: ["checks"],
  },
];

export const findRepository = (
  fullName: string
): RepositoryConfig | undefined =>
  repositories.find((entry) => entry.fullName === fullName);

/** The path of each pinned script in a target repository. */
export const pinnedPaths = {
  checkRecord: ".agents/skills/review-pr/check-record.sh",
  mergeSh: ".agents/skills/review-pr/merge.sh",
  recordRound: ".agents/skills/review-pr/record-round.sh",
} as const;

/** The per-repository hold files (spec 0000, "Kill switch" and D5). */
export const holdPaths = {
  bot: ".github/bot-hold",
  release: ".github/release-hold",
} as const;
