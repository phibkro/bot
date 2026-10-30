import type { Publisher } from "./publisher.ts";

/**
 * The only text the bot posts (spec 0000, D8). Templates over typed fields. The one piece of outside text, a PR title, is
 * rendered by `inert`, so that it cannot plant a review marker that `merge.sh` (which greps every comment for
 * `<!-- review-round ... -->`) or the bot's own parser would match, nor an `@mention`.
 */

/** The prefix of every marker the bot writes. It is not `review-round`, so no review record parser reads it. */
export const botMarkerPrefix = "<!-- release-bot";

export type CommentKind =
  | {
      readonly _tag: "Approval";
      readonly repository: string;
      readonly prNumber: number;
      readonly mode: string;
      readonly runId: number;
      readonly runUrl: string;
    }
  | {
      readonly _tag: "Report";
      readonly repository: string;
      readonly prNumber: number;
      readonly mode: string;
      readonly runId: number;
      readonly runUrl: string;
      readonly conclusion: string;
      readonly packages: readonly {
        readonly name: string;
        readonly version: string;
        readonly publisher: Publisher;
      }[];
      /** An optional paragraph from a `Narrator` (spec 0000, D12: none in v1); rendered inert. */
      readonly narration?: string | undefined;
    }
  | {
      readonly _tag: "Withheld";
      readonly repository: string;
      readonly prNumber: number;
      readonly reason: string;
    }
  | {
      readonly _tag: "MergeRefused";
      readonly repository: string;
      readonly prNumber: number;
      readonly title: string;
      readonly reason: string;
    };

/** Neutralise outside text: no backticks, no angle brackets (so no `<!--`), no mention or issue reference, one line, short. */
export const inert = (text: string): string =>
  text
    .replaceAll(/[`\r\n\t]/gu, " ")
    .replaceAll("<", "\u2039")
    .replaceAll(">", "\u203A")
    .replaceAll("@", "\uFF20")
    .replaceAll("#", "\uFF03")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 100);

/** A package name or version: the characters npm allows, anything else becomes `?` (no markup, no marker, no mention). */
const registryText = (text: string): string =>
  text.replaceAll(/[^A-Za-z0-9@/._+-]/gu, "?").slice(0, 100);

/** The idempotency key of a comment: one per repository, PR, kind and subject (the run id or a reason). */
export const commentKey = (comment: CommentKind): string => {
  const base = `comment:${comment.repository}#${comment.prNumber}:${comment._tag}`;

  switch (comment._tag) {
    case "Approval":
    case "Report": {
      return `${base}:${comment.mode}:${comment.runId}`;
    }

    case "Withheld":
    case "MergeRefused": {
      return `${base}:${comment.reason}`;
    }

    default: {
      return base;
    }
  }
};

const publisherLabel: Readonly<Record<Publisher, string>> = {
  "not-published": "not visible on the registry yet",
  oidc: "OIDC (trusted publisher)",
  token: "token",
};

const publisherLine = (entry: {
  readonly name: string;
  readonly version: string;
  readonly publisher: Publisher;
}): string => {
  const label = publisherLabel[entry.publisher];

  return `- \`${registryText(entry.name)}@${registryText(entry.version)}\`: ${label}`;
};

const bodyOf = (comment: CommentKind): string => {
  switch (comment._tag) {
    case "Approval": {
      return [
        `Release run \`${comment.mode}\` is waiting for **your** approval (the bot cannot approve a deployment).`,
        "",
        `Approve: ${comment.runUrl} (click **Review deployments**).`,
      ].join("\n");
    }

    case "Report": {
      const lines = [
        `Release run \`${comment.mode}\` ended: **${inert(comment.conclusion)}**. Run: ${comment.runUrl}`,
      ];

      if (comment.mode === "check") {
        lines.push(
          "",
          "A `check` run publishes nothing and runs without `id-token`: token path only."
        );
      } else if (comment.packages.length > 0) {
        lines.push(
          "",
          "Publisher per package, read from the registry:",
          ...comment.packages.map(publisherLine)
        );
      }

      if (comment.narration !== undefined) {
        lines.push("", inert(comment.narration));
      }

      return lines.join("\n");
    }

    case "Withheld": {
      return `The release dispatch was withheld: ${inert(comment.reason)}.`;
    }

    case "MergeRefused": {
      return `The bot did not merge \`${inert(comment.title)}\`: ${inert(comment.reason)}.`;
    }

    default: {
      return "";
    }
  }
};

/** The full comment: a marker line (`<!-- release-bot key=... -->`) and the body. The marker lets the bot find its own comment again. */
export const renderComment = (comment: CommentKind): string =>
  `${botMarkerPrefix} key=${commentKey(comment)} -->\n${bodyOf(comment)}\n`;
