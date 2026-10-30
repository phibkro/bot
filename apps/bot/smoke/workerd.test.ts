import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { matchOperation } from "@bot/service";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import type { Request as MiniflareRequest } from "miniflare";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

/**
 * The webhook path on the real runtime (spec 0000, Revisions 5): the Worker and the Durable Object, bundled as they deploy,
 * run in local workerd through Miniflare, with SQLite-backed storage and alarms, against a fake GitHub that answers from the
 * fixtures captured from the real API. It runs the signature check, the allowlist, admission, the duplicate, the alarm, the
 * bot's reads, and the verdict in the audit log, in observe mode: the fake must see no write. Nothing here touches a network
 * or a credential: the key and the secret are generated for the run.
 */

const here = import.meta.dirname;
const appRoot = path.resolve(here, "..");

const fixtures = path.join(
  appRoot,
  "..",
  "..",
  "packages",
  "service",
  "test",
  "fixtures",
  "github"
);

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(fixtures, name), "utf-8"));

const operatorId = 71_797_726;
const head = "5c33160314856ba99191df2dcd0fa4a52c89a302";
const webhookSecret = randomBytes(24).toString("hex");

const sign = (body: string): string =>
  `sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`;

interface Seen {
  readonly method: string;
  readonly url: string;
}

const seen: Seen[] = [];

/** Resolved when the bot reads the last of the facts it decides on (the comparison with the default branch): the alarm ran. */
const factsRead = Promise.withResolvers<void>();
let root = "";
let mf: Miniflare | undefined;

/** The fake GitHub: the shapes are the captured ones; the one pull request is open, reviewed (a pass by the operator) and green. */
const github = (request: MiniflareRequest): MiniflareResponse => {
  const url = new URL(request.url);
  seen.push({ method: request.method, url: request.url });

  const json = (body: unknown, status = 200): MiniflareResponse =>
    MiniflareResponse.json(body, { status });

  const { pathname } = url;

  if (pathname === "/app/installations") {
    return json([{ account: { id: operatorId }, id: 5, suspended_at: null }]);
  }

  if (pathname === "/app/installations/5/access_tokens") {
    return json(
      { expires_at: "2099-01-01T00:00:00Z", token: "ghs_smoke" },
      201
    );
  }

  if (pathname.endsWith("/pulls/7")) {
    return json({
      base: { ref: "main", repo: { full_name: "phibkro/pg-txmode" } },
      draft: false,
      head: { repo: { full_name: "phibkro/pg-txmode" }, sha: head },
      mergeable: true,
      merged: false,
      number: 7,
      state: "open",
      title: "feat: smoke",
    });
  }

  if (pathname.endsWith("/pulls/7/reviews")) {
    const [first] = fixture("reviews-record.json") as { body: string }[];
    const body = (first?.body ?? "").replace("verdict=changes", "verdict=pass");

    return json([
      {
        body,
        state: "COMMENTED",
        submitted_at: "2026-10-30T12:00:00Z",
        user: { id: operatorId },
      },
    ]);
  }

  if (pathname.endsWith("/issues/7/comments")) {
    return json([]);
  }

  if (pathname.endsWith("/check-runs")) {
    return json(fixture("check-runs.json"));
  }

  if (pathname.endsWith("/status")) {
    return json(fixture("status.json"));
  }

  if (pathname.includes("/compare/")) {
    factsRead.resolve();

    return json({ ...(fixture("compare-ahead.json") as object), behind_by: 0 });
  }

  if (pathname.endsWith("/review-pr/merge.sh")) {
    return json({
      sha: "40d6be4d7897d56d369af7275e99e4926f933a02",
      type: "file",
    });
  }

  if (pathname.endsWith("/review-pr/record-round.sh")) {
    return json({
      sha: "646bb10606f1b6683908e8e0f0171ec611032f8b",
      type: "file",
    });
  }

  return json({ message: "Not Found" }, 404);
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "bot-smoke-"));
  execFileSync(
    "bun",
    [
      "build",
      "src/worker.ts",
      "--outdir",
      root,
      "--format",
      "esm",
      "--target",
      "browser",
      "--external",
      "cloudflare:workers",
    ],
    {
      cwd: appRoot,
      stdio: "ignore",
    }
  );

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs1" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });

  mf = new Miniflare({
    bindings: {
      GITHUB_APP_CLIENT_ID: "Iv1.smoke",
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_WEBHOOK_SECRET: webhookSecret,
    },
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      RELEASE_BOT: { className: "ReleaseBot", useSQLite: true },
    },
    modules: [
      {
        contents: readFileSync(path.join(root, "worker.js"), "utf-8"),
        path: "worker.js",
        type: "ESModule",
      },
    ],
    outboundService: github,
  });
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  rmSync(root, { force: true, recursive: true });
});

const post = async (
  body: string,
  headers: Record<string, string>
): Promise<{ status: number; text: string }> => {
  const response = await mf?.dispatchFetch("http://bot.test/webhook/github", {
    body,
    headers,
    method: "POST",
  });

  return {
    status: response?.status ?? 0,
    text: (await response?.text()) ?? "",
  };
};

const event = JSON.stringify({
  action: "submitted",
  pull_request: { number: 7 },
  repository: { full_name: "phibkro/pg-txmode", owner: { id: operatorId } },
});

const auditOf = async (): Promise<{ kind: string; detail: string }[]> => {
  const namespace = await mf?.getDurableObjectNamespace("RELEASE_BOT");
  const stub = namespace?.get(namespace.idFromName("operator"));
  const response = await stub?.fetch("http://object/audit");

  return (await response?.json()) as { kind: string; detail: string }[];
};

describe("the Worker and the Durable Object in workerd", () => {
  test("F5: a bad signature is 401, a good ping is 200", async () => {
    expect(
      (
        await post(event, {
          "x-github-delivery": "s0",
          "x-github-event": "pull_request_review",
          "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
        })
      ).status
    ).toBe(401);
    expect(
      (
        await post("{}", {
          "x-github-delivery": "s1",
          "x-github-event": "ping",
          "x-hub-signature-256": sign("{}"),
        })
      ).status
    ).toBe(200);
    expect(seen).toEqual([]);
  });

  test("F15: a stranger's installation is dropped before the object: no read, no row", async () => {
    const stranger = event.replace(String(operatorId), "12345");

    const answer = await post(stranger, {
      "x-github-delivery": "s2",
      "x-github-event": "pull_request_review",
      "x-hub-signature-256": sign(stranger),
    });

    expect(answer).toEqual({ status: 202, text: "ignored" });
    expect(seen).toEqual([]);
  });

  test("F4, F11: a delivery is admitted once, the alarm reads the PR, decides Merge, and observe mode writes nothing", async () => {
    const headers = {
      "x-github-delivery": "s3",
      "x-github-event": "pull_request_review",
      "x-hub-signature-256": sign(event),
    };

    expect(await post(event, headers)).toEqual({
      status: 202,
      text: "admitted",
    });
    expect(await post(event, headers)).toEqual({
      status: 200,
      text: "duplicate",
    });

    // The alarm runs in the object on the runtime's own clock: wait for the bot's last read, then read the audit log until the
    // verdict row is there (each read is a round trip into the object, so this loop needs no timer).
    await factsRead.promise;
    let audit: { kind: string; detail: string }[] = [];

    for (
      let attempt = 0;
      attempt < 500 && !audit.some((entry) => entry.kind === "merge-verdict");
      attempt += 1
    ) {
      audit = await auditOf();
    }

    const verdict = audit.find((entry) => entry.kind === "merge-verdict");
    expect(verdict?.detail).toContain('"_tag":"Merge"');
    expect(verdict?.detail).toContain('"mode":"observe"');
    expect(verdict?.detail).not.toContain("ghs_smoke");

    // Every request the bot made is a declared operation, and none is a write (F6, F11); the token mint is the one POST.
    for (const request of seen) {
      expect(
        matchOperation(request.method, request.url),
        `${request.method} ${request.url}`
      ).toBeDefined();
    }

    expect(
      seen
        .filter((request) => request.method !== "GET")
        .map((request) => `${request.method} ${new URL(request.url).pathname}`)
    ).toEqual(["POST /app/installations/5/access_tokens"]);
  }, 30_000);
});
