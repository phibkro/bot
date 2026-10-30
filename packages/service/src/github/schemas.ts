import { Schema } from "effect";

/**
 * The subsets of GitHub's responses (API version 2026-03-10) that the bot decodes, each at the service that receives it
 * (spec 0000, D11). Extra fields are ignored; a missing or mistyped field is a `DecodeFailure`. Fixtures captured from the
 * real API (`test/fixtures`, `tools/capture/capture.sh`) are decoded by these schemas in the tests.
 */

const optionalNull = <S extends Schema.Constraint>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

export const PullRequest = Schema.Struct({
  base: Schema.Struct({
    ref: Schema.String,
    repo: Schema.Struct({ full_name: Schema.String }),
  }),
  draft: Schema.optional(Schema.Boolean),
  head: Schema.Struct({
    repo: optionalNull(Schema.Struct({ full_name: Schema.String })),
    sha: Schema.String,
  }),
  merge_commit_sha: optionalNull(Schema.String),
  mergeable: optionalNull(Schema.Boolean),
  merged: Schema.optional(Schema.Boolean),
  number: Schema.Int,
  /** Present only on a PR in a native stack: the real API omits the key otherwise (verified on a real PR, spec 0000, V7). */
  stack: optionalNull(Schema.Unknown),
  state: Schema.String,
  title: Schema.String,
});

export const PullList = Schema.Array(
  Schema.Struct({
    head: Schema.Struct({ sha: Schema.String }),
    number: Schema.Int,
    state: Schema.String,
    title: Schema.String,
  })
);

export const Reviews = Schema.Array(
  Schema.Struct({
    body: optionalNull(Schema.String),
    state: Schema.String,
    submitted_at: optionalNull(Schema.String),
    user: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
  })
);

export const IssueComments = Schema.Array(
  Schema.Struct({
    body: optionalNull(Schema.String),
    created_at: Schema.String,
    id: Schema.Int,
    user: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
  })
);

export const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      app: optionalNull(Schema.Struct({ slug: optionalNull(Schema.String) })),
      conclusion: Schema.NullOr(Schema.String),
      name: Schema.String,
      status: Schema.String,
    })
  ),
  total_count: Schema.Int,
});

export const CombinedStatus = Schema.Struct({
  statuses: Schema.Array(
    Schema.Struct({ context: Schema.String, state: Schema.String })
  ),
});

export const Compare = Schema.Struct({
  behind_by: Schema.Int,
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filename: Schema.String,
        previous_filename: Schema.optional(Schema.String),
      })
    )
  ),
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
});

/** `GET contents/{path}` of a file: the blob sha is what the pins compare. */
export const ContentFile = Schema.Struct({
  content: Schema.optional(Schema.String),
  sha: Schema.String,
  type: Schema.String,
});

export const CommitRef = Schema.Struct({ sha: Schema.String });

/** `PUT merge-async` and its poll: `pending` has a `uuid`, `merged` has the merge commit `sha`. */
export const MergeAsyncResult = Schema.Struct({
  details: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      sha: Schema.optional(Schema.String),
      uuid: Schema.optional(Schema.String),
    })
  ),
  status: Schema.Literals(["pending", "merged", "enqueued", "failed"]),
});

/** The only dispatch response in API 2026-03-10 (spec 0000, D6): always 200 with the run's id and URLs. */
export const DispatchResponse = Schema.Struct({
  html_url: Schema.String,
  run_url: Schema.String,
  workflow_run_id: Schema.Int,
});

export const WorkflowRun = Schema.Struct({
  conclusion: Schema.NullOr(Schema.String),
  event: Schema.String,
  head_branch: optionalNull(Schema.String),
  head_sha: Schema.String,
  html_url: Schema.String,
  id: Schema.Int,
  status: Schema.String,
});

export const WorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(WorkflowRun),
});

export const Installations = Schema.Array(
  Schema.Struct({
    account: Schema.NullOr(Schema.Struct({ id: Schema.Int })),
    id: Schema.Int,
    suspended_at: optionalNull(Schema.String),
  })
);

export const InstallationToken = Schema.Struct({
  expires_at: Schema.String,
  token: Schema.String,
});

export const PullFiles = Schema.Array(
  Schema.Struct({ filename: Schema.String, status: Schema.String })
);

export const CreatedComment = Schema.Struct({ id: Schema.Int });

/** A package manifest at the merge commit: the registry names a version by these three fields. */
export const PackageManifest = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean),
  version: Schema.String,
});

/** The version document of the npm registry; personal fields are not decoded. */
export const NpmVersionDoc = Schema.Struct({
  _npmUser: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        email: Schema.optional(Schema.String),
        name: Schema.optional(Schema.String),
      }),
    ])
  ),
  name: Schema.String,
  version: Schema.String,
});
