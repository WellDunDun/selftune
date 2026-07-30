export const CREATOR_CONTRIBUTIONS_HELP = `selftune creator-contributions — Manage creator sharing setup configs

Usage:
  selftune creator-contributions
  selftune creator-contributions status [--skill <name>]
  selftune creator-contributions enable --skill <name> [--skill-path <path>] [--creator-id <id>] [--signals a,b,c] [--no-helper]
  selftune creator-contributions enable --all [--prefix <prefix>] [--creator-id <id>] [--signals a,b,c] [--no-helper]
  selftune creator-contributions disable --skill <name> [--skill-path <path>]

Purpose:
  Manage the local selftune.contribute.json creator sharing setup file that
  a skill creator bundles with a skill package. The --creator-id must be the
  creator's cloud user UUID (the cloud_user_id from alpha enrollment).
  By default, enable also writes a portable selftune-feedback.mjs helper so
  downstream agents can send privacy-safe signals without installing selftune.
  This is separate from:
    selftune contributions  Sharing preferences (end-user opt-in/out)
    selftune contribute     Community export bundle`;

export const CREATOR_CONTRIBUTIONS_STATUS_HELP =
  "Usage: selftune creator-contributions status [--skill <name>]";
export const CREATOR_CONTRIBUTIONS_ENABLE_HELP =
  "Usage: selftune creator-contributions enable (--skill <name> [--skill-path <path>] | --all [--prefix <prefix>]) [--creator-id <id>]";
export const CREATOR_CONTRIBUTIONS_DISABLE_HELP =
  "Usage: selftune creator-contributions disable --skill <name> [--skill-path <path>]";
