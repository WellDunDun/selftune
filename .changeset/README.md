# Changesets

Every pull request that changes a shipped SelfTune surface must include a changeset.
Run `bun run changeset`, select `selftune`, and describe the user-visible change.

The `selftune` npm package and `@selftune/desktop` are a fixed release group. A
single `selftune` changeset advances both versions in the post-merge Version
Packages pull request.
