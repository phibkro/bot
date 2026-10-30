/**
 * The GitHub App's registration as data (spec 0000, "GitHub App: permissions and events"). The single source of three
 * derivations: the egress table of the service (every operation's permission must be granted here), the operator checklist
 * (`docs/operator-checklist.md`, generated), and the App manifest. Granting more is a change of authority: it needs a spec
 * Revisions entry and the operator's decision.
 */

export type PermissionLevel = "read" | "write";

export type PermissionName =
  | "metadata"
  | "pull_requests"
  | "issues"
  | "contents"
  | "checks"
  | "statuses"
  | "actions";

/** Repository permissions requested, with the reason for each (spec 0000, the permissions table). */
export const appPermissions: Readonly<
  Record<
    PermissionName,
    { readonly level: PermissionLevel; readonly reason: string }
  >
> = {
  actions: {
    level: "write",
    reason:
      "dispatch release.yml; read runs, jobs and logs; the workflow_run and workflow_job events",
  },
  checks: {
    level: "read",
    reason: "read check runs of a head; the check_run event",
  },
  contents: {
    level: "write",
    reason:
      "the merge (PUT .../merge-async and its poll list only Contents: write); reads of compare, contents and commits",
  },
  issues: {
    level: "write",
    reason:
      "read and create PR comments; the issue_comment event needs Issues read",
  },
  metadata: { level: "read", reason: "mandatory for every GitHub App" },
  pull_requests: {
    level: "read",
    reason:
      "read PRs, reviews and files; the pull_request and pull_request_review events (not write: it would open PRs and approve)",
  },
  statuses: { level: "read", reason: "read commit statuses; the status event" },
};

/** Permissions that the App must never hold (spec 0000, "Authority" and "Permissions"). */
export const forbiddenPermissions: readonly string[] = [
  "deployments",
  "environments",
  "workflows",
  "administration",
  "secrets",
  "variables",
  "members",
];

/** Webhook events to subscribe to; `installation` is sent to every App and cannot be subscribed to. */
export const appEvents = [
  "pull_request_review",
  "issue_comment",
  "pull_request",
  "check_run",
  "status",
  "workflow_job",
  "workflow_run",
] as const;

export type AppEvent = (typeof appEvents)[number];

/** The API version sent on every request and used to decode every response (spec 0000, D6). */
export const githubApiVersion = "2026-03-10";

/** The names of the two secrets and the two plain variables of the Worker (values are never written down). */
export const secretNames = [
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
] as const;

export const variableNames = ["GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID"] as const;

export const levelAtLeast = (
  granted: PermissionLevel,
  needed: PermissionLevel
): boolean => granted === "write" || needed === "read";
