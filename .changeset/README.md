# Changesets

Every pull request that changes a shipped SelfTune surface must include a changeset.
Run `bun run changeset`, select `@selftune/desktop`, and describe the user-visible change.

`@selftune/desktop` is the workspace-visible owner of the coupled release train.
A desktop changeset advances its version, then `changeset:version` synchronizes
the root `selftune` npm package to the same version in the post-merge Version
Packages pull request.
