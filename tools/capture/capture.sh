#!/usr/bin/env bash
# capture.sh <fixtures-dir>: read-only captures of real GitHub and npm responses, projected to the fields the bot decodes
# (the projection drops personal fields; it never adds or renames a field, so the shape is the API's own).
# Needs `gh` (authenticated, read access to the public repositories below) and `curl`. Writes nothing outside <fixtures-dir>.
# Spec 0000, F17 and F20: fixtures come from real responses, with the command that produced each one in its header file.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: capture.sh <fixtures-dir>" >&2; exit 64; }
out=$1
mkdir -p "$out/github" "$out/npm"
repo=phibkro/pg-txmode
tip=$(gh api "repos/$repo/commits/main" --jq .sha)
old=$(gh api "repos/$repo/commits/e748721" --jq .sha)

cmd() { printf '%s\n' "$1" >>"$out/COMMANDS.txt"; }
: >"$out/COMMANDS.txt"

cmd "gh api repos/$repo/pulls/18 | jq <project PR fields>"
gh api "repos/$repo/pulls/18" | jq '{number, title, state, draft, merged, merge_commit_sha, mergeable, mergeable_state,
  user: {id: .user.id, type: .user.type}, head: {sha: .head.sha, ref: .head.ref, repo: {full_name: .head.repo.full_name}},
  base: {ref: .base.ref, repo: {full_name: .base.repo.full_name, default_branch: .base.repo.default_branch}}}' >"$out/github/pull-merged.json"

cmd "gh api repos/phibkro/bot/pulls/1/reviews | jq <project review fields>"
gh api "repos/phibkro/bot/pulls/1/reviews" | jq '[.[] | {id, body, state, submitted_at, commit_id, user: {id: .user.id, type: .user.type}}]' >"$out/github/reviews-record.json"

cmd "gh api repos/$repo/compare/$old...$tip (main is an ancestor of the head: behind_by 0)"
gh api "repos/$repo/compare/$old...$tip" | jq '{status, ahead_by, behind_by, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}, files: [.files[] | {filename, status} + (if .previous_filename then {previous_filename} else {} end)]}' >"$out/github/compare-ahead.json"

cmd "gh api repos/$repo/compare/$tip...$old (main moved past the head: behind_by > 0)"
gh api "repos/$repo/compare/$tip...$old" | jq '{status, ahead_by, behind_by, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}, files: [.files[] | {filename, status} + (if .previous_filename then {previous_filename} else {} end)]}' >"$out/github/compare-behind.json"

cmd "gh api repos/$repo/commits/$tip/check-runs"
gh api "repos/$repo/commits/$tip/check-runs" | jq '{total_count, check_runs: [.check_runs[] | {name, status, conclusion, app: {slug: .app.slug}}]}' >"$out/github/check-runs.json"

cmd "gh api repos/$repo/commits/$tip/status"
gh api "repos/$repo/commits/$tip/status" | jq '{state, statuses: [.statuses[] | {context, state}]}' >"$out/github/status.json"

cmd "gh api repos/$repo/contents/.agents/skills/review-pr/merge.sh?ref=main (content dropped; the blob sha stays)"
gh api "repos/$repo/contents/.agents/skills/review-pr/merge.sh?ref=main" | jq '{name, path, sha, size, type}' >"$out/github/contents-merge-sh.json"

cmd "gh api repos/$repo/pulls?state=closed&per_page=3 | jq <project>"
gh api "repos/$repo/pulls?state=closed&per_page=3" | jq '[.[] | {number, title, state, draft, merged_at, head: {sha: .head.sha}, base: {ref: .base.ref}}]' >"$out/github/pulls-list.json"

for v in 0.1.0-alpha.0 0.1.0-alpha.1 0.1.0-alpha.2; do
  cmd "curl https://registry.npmjs.org/@pg-txmode%2fcore/$v | jq <project; personal fields replaced>"
  curl -fsS "https://registry.npmjs.org/@pg-txmode%2fcore/$v" | jq '{name, version, dist: {attestations: .dist.attestations},
    _npmUser: (if ._npmUser.email == "npm-oidc-no-reply@github.com" then ._npmUser else {name: "redacted", email: "redacted@example.invalid"} end)}' >"$out/npm/core-$v.json"
done
echo "captured into $out"
