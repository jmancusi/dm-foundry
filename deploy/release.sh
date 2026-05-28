#!/usr/bin/env bash
# Release a new version of dm-sync to GitHub.
#
# Reads the version from module.json, tags the current HEAD with v<version>,
# pushes the tag, builds dm-sync.zip from that commit, and publishes a GitHub
# release with the zip attached.
#
# Run from anywhere inside the repo:
#   ./deploy/release.sh
#
# After this finishes, you still need to:
#   1. ssh to the Linode and run: sudo /var/www/dm/deploy/deploy-all.sh
#   2. In Foundry: Game Settings → Manage Modules → Check for Updates → Update.
#
# Bumping the version is a separate, deliberate step: edit module.json, commit,
# push, then run this script.
set -euo pipefail

# Locate repo root (this script lives in deploy/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ---- preflight -------------------------------------------------------------

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not installed. Get it from https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI not authenticated. Run: gh auth login" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "main" ]; then
  echo "Not on main (currently: $current_branch). Switch to main first." >&2
  exit 1
fi

echo "Fetching origin..."
git fetch origin --quiet

local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
if [ "$local_head" != "$remote_head" ]; then
  echo "Local main is out of sync with origin/main." >&2
  echo "  local:  $local_head" >&2
  echo "  remote: $remote_head" >&2
  echo "Pull or push so the release tag matches what's on GitHub." >&2
  exit 1
fi

version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' module.json \
  | head -n1 \
  | sed 's/.*"\([^"]*\)"$/\1/')"
if [ -z "$version" ]; then
  echo "Could not read version from module.json" >&2
  exit 1
fi
tag="v${version}"

if git rev-parse --verify "refs/tags/${tag}" >/dev/null 2>&1; then
  echo "Tag ${tag} already exists locally." >&2
  echo "If you actually want to re-release this version, first remove the old one:" >&2
  echo "  git tag -d ${tag}" >&2
  echo "  git push origin :refs/tags/${tag}" >&2
  echo "  gh release delete ${tag} --yes" >&2
  exit 1
fi
if gh release view "${tag}" >/dev/null 2>&1; then
  echo "GitHub release ${tag} already exists." >&2
  echo "Bump the version in module.json or delete the existing release first." >&2
  exit 1
fi

echo "Releasing ${tag} from ${local_head:0:7}"

# ---- build the zip ---------------------------------------------------------

zip_path="/tmp/dm-sync.zip"
rm -f "$zip_path"

# git archive guarantees the zip contents match the committed tree exactly —
# uncommitted edits would never sneak in even if the preflight missed them.
git archive --format=zip -o "$zip_path" HEAD module.json scripts lang

echo
echo "Built $zip_path:"
unzip -l "$zip_path" | sed 's/^/  /'

# ---- tag + push + release --------------------------------------------------

echo
echo "Tagging ${tag}..."
git tag -a "${tag}" -m "Release ${tag}"
git push origin "${tag}"

echo
echo "Publishing GitHub release ${tag}..."
gh release create "${tag}" "$zip_path" \
  --title "${tag}" \
  --generate-notes

# ---- wrap up ---------------------------------------------------------------

cat <<EOF

================================================================
Released ${tag}
  https://github.com/jmancusi/dm-foundry/releases/tag/${tag}

Now finish the deploy:
  1. ssh to the Linode and run:
       sudo /var/www/dm/deploy/deploy-all.sh
  2. In Foundry: Game Settings → Manage Modules → Check for Updates → Update.
================================================================
EOF
