import type { PermissionLevel, PermissionName } from "@bot/rules";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { EgressDenied } from "../errors.ts";

/**
 * The egress table (spec 0000, F6): every `(method, path)` the bot may send to GitHub, and the permission each needs. It is the
 * only list of what the bot can do on GitHub. Nothing here approves a deployment, opens a PR, writes a file, a ref, a tag or a
 * release; the guard fails a request outside the table, and a test checks that every operation's permission is one the App is
 * granted (`appPermissions` in `@bot/rules`).
 */

export interface DeclaredOperation {
  readonly name: string;
  readonly method: "GET" | "POST" | "PUT";
  readonly pattern: RegExp;
  /** The installation permission the operation needs, or `app` for the endpoints that take the App's JWT. */
  readonly permission:
    | "app"
    | { readonly name: PermissionName; readonly level: PermissionLevel };
}

const repo = String.raw`/repos/[^/]+/[^/]+`;

const need = (name: PermissionName, level: PermissionLevel) =>
  ({ level, name }) as const;

export const declaredOperations: readonly DeclaredOperation[] = [
  {
    method: "GET",
    name: "listInstallations",
    pattern: /^\/app\/installations$/u,
    permission: "app",
  },
  {
    method: "POST",
    name: "createInstallationToken",
    pattern: /^\/app\/installations\/\d+\/access_tokens$/u,
    permission: "app",
  },
  {
    method: "GET",
    name: "getPull",
    pattern: new RegExp(`^${repo}/pulls/\\d+$`, "u"),
    permission: need("pull_requests", "read"),
  },
  {
    method: "GET",
    name: "listPulls",
    pattern: new RegExp(`^${repo}/pulls$`, "u"),
    permission: need("pull_requests", "read"),
  },
  {
    method: "GET",
    name: "listReviews",
    pattern: new RegExp(`^${repo}/pulls/\\d+/reviews$`, "u"),
    permission: need("pull_requests", "read"),
  },
  {
    method: "GET",
    name: "listPullFiles",
    pattern: new RegExp(`^${repo}/pulls/\\d+/files$`, "u"),
    permission: need("pull_requests", "read"),
  },
  {
    method: "GET",
    name: "listIssueComments",
    pattern: new RegExp(`^${repo}/issues/\\d+/comments$`, "u"),
    permission: need("issues", "read"),
  },
  {
    method: "GET",
    name: "listCheckRuns",
    pattern: new RegExp(`^${repo}/commits/[^/]+/check-runs$`, "u"),
    permission: need("checks", "read"),
  },
  {
    method: "GET",
    name: "getCombinedStatus",
    pattern: new RegExp(`^${repo}/commits/[^/]+/status$`, "u"),
    permission: need("statuses", "read"),
  },
  {
    method: "GET",
    name: "compare",
    pattern: new RegExp(`^${repo}/compare/.+$`, "u"),
    permission: need("contents", "read"),
  },
  {
    method: "GET",
    name: "getContent",
    pattern: new RegExp(`^${repo}/contents/.+$`, "u"),
    permission: need("contents", "read"),
  },
  {
    method: "GET",
    name: "getCommit",
    pattern: new RegExp(`^${repo}/commits/[^/]+$`, "u"),
    permission: need("contents", "read"),
  },
  {
    method: "GET",
    name: "listWorkflowRuns",
    pattern: new RegExp(`^${repo}/actions/workflows/[^/]+/runs$`, "u"),
    permission: need("actions", "read"),
  },
  {
    method: "GET",
    name: "getRun",
    pattern: new RegExp(`^${repo}/actions/runs/\\d+$`, "u"),
    permission: need("actions", "read"),
  },
  {
    method: "PUT",
    name: "mergeAsync",
    pattern: new RegExp(`^${repo}/pulls/\\d+/merge-async$`, "u"),
    permission: need("contents", "write"),
  },
  {
    method: "GET",
    name: "pollMerge",
    pattern: new RegExp(`^${repo}/pulls/\\d+/merge-async/[^/]+$`, "u"),
    permission: need("contents", "write"),
  },
  {
    method: "POST",
    name: "dispatchWorkflow",
    pattern: new RegExp(`^${repo}/actions/workflows/[^/]+/dispatches$`, "u"),
    permission: need("actions", "write"),
  },
  {
    method: "POST",
    name: "createComment",
    pattern: new RegExp(`^${repo}/issues/\\d+/comments$`, "u"),
    permission: need("issues", "write"),
  },
];

export const apiHost = "api.github.com";

/** The operation a request is, or `undefined` when it is not declared. The host must be `api.github.com` over https. */
export const matchOperation = (
  method: string,
  url: string
): DeclaredOperation | undefined => {
  const parsed = URL.canParse(url) ? new URL(url) : undefined;

  if (
    parsed === undefined ||
    parsed.protocol !== "https:" ||
    parsed.host !== apiHost
  ) {
    return undefined;
  }

  return declaredOperations.find(
    (operation) =>
      operation.method === method && operation.pattern.test(parsed.pathname)
  );
};

/** Wrap a client so that a request outside the table fails with `EgressDenied` before it leaves (spec 0000, F6). */
export const guardEgress = <E, R>(
  client: HttpClient.HttpClient.With<E, R>
): HttpClient.HttpClient.With<E | EgressDenied, R> =>
  HttpClient.mapRequestEffect(client, (request) =>
    matchOperation(request.method, request.url) === undefined
      ? Effect.fail(
          new EgressDenied({ method: request.method, path: request.url })
        )
      : Effect.succeed(request)
  );
