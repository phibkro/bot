import { allowedAccounts, operatorIds, repositories } from "@bot/rules";
import type { Account, RepositoryConfig } from "@bot/rules";
import { Context } from "effect";

/**
 * The declared configuration (`@bot/rules`, `config.ts`) as a defaulted reference, so that a test can run the bot against a
 * smaller or different declaration (for example a repository in `act` mode) without changing the code under test.
 */
export interface BotSettings {
  /** Accounts whose installations the Worker accepts (spec 0000, O2): checked before the Durable Object. */
  readonly allowedAccounts: readonly Account[];
  readonly repositories: readonly RepositoryConfig[];
  readonly operatorIds: readonly number[];
  /** How often the reconcile sweep re-reads every open PR and run (spec 0000, D4). */
  readonly sweepIntervalMs: number;
  /** How long after a run concluded the report waits for the registry to show a version (spec 0000, failure modes). */
  readonly registryPatienceMs: number;
}

export const BotConfig = Context.Reference<BotSettings>("bot/BotConfig", {
  defaultValue: () => ({
    allowedAccounts,
    operatorIds,
    registryPatienceMs: 5 * 60 * 1000,
    repositories,
    sweepIntervalMs: 10 * 60 * 1000,
  }),
});
