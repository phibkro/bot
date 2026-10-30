import type { RecordFact } from "./types.ts";

/** What `record-round.sh` writes as the first line of a review round (spec 0000, D2): `<!-- review-round n=N head=SHA verdict=V -->`. */
export interface ParsedRecord {
  readonly round: number;
  readonly head: string;
  readonly verdict: "pass" | "changes";
}

const markerPattern =
  /^<!-- review-round n=(?<round>[1-9][0-9]*) head=(?<head>[0-9a-f]{40}) verdict=(?<verdict>pass|changes) -->$/u;

/**
 * Parse the **first line** of a body (V2: a marker quoted further down does not count). The grammar is that of
 * `record-round.sh`: `n` a positive integer, `head` 40 lower-case hex, `verdict` `pass` or `changes`.
 */
export const parseRecord = (body: string): ParsedRecord | undefined => {
  const [firstLine = ""] = body.split("\n", 1);
  const match = markerPattern.exec(firstLine.replace(/\r$/u, ""));

  if (match?.groups === undefined) {
    return undefined;
  }

  const { round = "", head = "", verdict = "" } = match.groups;

  return {
    head,
    round: Number(round),
    verdict: verdict === "pass" ? "pass" : "changes",
  };
};

export type RecordOutcome =
  | { readonly _tag: "Pass"; readonly record: RecordFact }
  | { readonly _tag: "None" }
  | { readonly _tag: "Author" }
  | { readonly _tag: "Changed" };

const isLater = (
  a: ParsedRecord & RecordFact,
  b: ParsedRecord & RecordFact
): boolean => (a.round === b.round ? a.at > b.at : a.round > b.round);

/** The verdict on the latest record by an operator for the head, or the reason there is none. */
const outcomeOf = (
  latest: (ParsedRecord & RecordFact) | undefined,
  strangerPass: boolean
): RecordOutcome => {
  if (latest === undefined) {
    return strangerPass ? { _tag: "Author" } : { _tag: "None" };
  }

  if (latest.verdict !== "pass") {
    return { _tag: "None" };
  }

  return latest.changedSinceFirstRead
    ? { _tag: "Changed" }
    : { _tag: "Pass", record: latest };
};

/**
 * V1, V2, V3, V8 on top of rule 1 of `merge.sh`: is there a pass for `head` by an operator account that is the latest record
 * for that head (round number, then timestamp), is not in a dismissed review, and has not been edited since the bot first read it?
 */
export const passRecordFor = (
  head: string,
  operatorIds: readonly number[],
  records: readonly RecordFact[]
): RecordOutcome => {
  let latest: (ParsedRecord & RecordFact) | undefined;
  let strangerPass = false;

  for (const record of records) {
    const parsed = record.dismissed ? undefined : parseRecord(record.body);

    if (parsed === undefined || parsed.head !== head) {
      continue;
    }

    if (!operatorIds.includes(record.authorId)) {
      strangerPass ||= parsed.verdict === "pass";
      continue;
    }

    const candidate = { ...record, ...parsed };

    if (latest === undefined || isLater(candidate, latest)) {
      latest = candidate;
    }
  }

  return outcomeOf(latest, strangerPass);
};
