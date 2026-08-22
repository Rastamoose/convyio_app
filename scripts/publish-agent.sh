#!/usr/bin/env bash
# Publishes packages/agent to npm under the public name `convyio-agent`.
#
# packages/agent is `@workspace/agent` (private) in this monorepo, but ships
# to users as `convyio-agent`. This bumps the version and commits it under
# the real workspace name, then temporarily flips name/private/etc. just for
# `npm publish` and reverts via `git checkout` — so the published
# package.json is always derived from the real one (dependencies included)
# instead of a hand-maintained copy that can silently drift out of date.
set -euo pipefail
cd "$(dirname "$0")/../packages/agent"

version="${1:?Usage: scripts/publish-agent.sh <version>}"

if [[ -n "$(git status --porcelain .)" ]]; then
  echo "packages/agent has uncommitted changes — commit or stash first." >&2
  exit 1
fi

npm version "$version" --no-git-tag-version
git add package.json
git commit -m "convyio-agent v$version"

trap 'git checkout -- package.json' EXIT

npm pkg set name=convyio-agent license=MIT \
  description="Run a local coding agent (Claude Code / Codex) paired to a Convyio workspace."
# --json so `false` lands as a real boolean; a plain `private=false` writes the
# string "false", which is truthy — npm then treats it as still-private and
# silently skips the publish (no error, nothing lands on the registry).
npm pkg set private=false --json
npm pkg set "files[0]=dist/cli.js"

# `npm publish` from inside this workspace member no-ops with "Ignoring
# workspaces"-style skips even once private is a real false; publishing the
# packed tarball directly sidesteps npm's workspace resolution entirely.
tarball="$(npm pack --pack-destination /tmp | tail -1)"
npm publish "/tmp/$tarball" --access public
rm -f "/tmp/$tarball"

echo "Published convyio-agent@$version (commit $(git rev-parse --short HEAD) has the version bump)."
