/** The `_npmUser` of a version document: the registry prints an object (`{ name, email }`) and `npm view` prints `name <email>`. */
export type NpmUser =
  | string
  | { readonly name?: string | undefined; readonly email?: string | undefined };

export type Publisher = "oidc" | "token" | "not-published";

/** The address npm gives the GitHub Actions identity of a trusted (OIDC) publish. */
export const oidcPublisherEmail = "npm-oidc-no-reply@github.com";

/**
 * `classifyPublisher` (spec 0000, "The report"): `oidc` when the version document's `_npmUser` carries the trusted-publisher
 * address, `token` for any other publisher, `not-published` when the registry has no such version. The registry's field is
 * observed, not documented (INFERENCE in the spec); provenance does not discriminate, since a token publish signs it too.
 */
export const classifyPublisher = (
  doc: { readonly _npmUser?: NpmUser | undefined } | undefined
): Publisher => {
  if (doc === undefined) {
    return "not-published";
  }

  const user = doc._npmUser;
  const email = typeof user === "string" ? user : (user?.email ?? "");

  return email.includes(oidcPublisherEmail) ? "oidc" : "token";
};
