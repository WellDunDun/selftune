#!/usr/bin/env sh

set -eu

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect-smol"
repo_ref="effect@4.0.0-beta.66"

if [ -d "$repo_dir/.git" ] && [ "$(git -C "$repo_dir" rev-parse HEAD)" = "$(git -C "$repo_dir" rev-list -n 1 "$repo_ref" 2>/dev/null || true)" ]; then
  exit 0
fi

if [ -d "$repo_dir/.git" ]; then
  git -C "$repo_dir" fetch --depth 1 origin "refs/tags/$repo_ref:refs/tags/$repo_ref"
  git -C "$repo_dir" checkout --detach "$repo_ref"
  exit 0
fi

mkdir -p ".repos"
git clone --branch "$repo_ref" --depth 1 "$repo_url" "$repo_dir"
