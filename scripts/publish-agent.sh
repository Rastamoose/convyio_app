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

npm pkg set name=convyio-agent private=false license=MIT \
  description="Run a local coding agent (Claude Code / Codex) paired to a Convyio workspace."
npm pkg set files[0]=dist/cli.js

npm publish --access public

echo "Published convyio-agent@$version (commit $(git rev-parse --short HEAD) has the version bump)."
