export const CONTRIBUTE_HELP = `selftune contribute — Export an anonymized community export bundle

Usage:
  selftune contribute --skill <name> [--preview] [--sanitize conservative|aggressive]
  selftune contribute --skill <name> [--output <file>] [--submit]

Purpose:
  Build a sanitized community export bundle from local SQLite data.
  This is separate from:
    selftune contributions  Sharing preferences (creator-directed opt-in/out)
    selftune alpha upload   Personal cloud upload cycle

Options:
  --skill <name>                    Skill to export
  --preview                         Print the sanitized bundle instead of writing it
  --sanitize conservative|aggressive
                                    Choose the sanitization level
  --output <file>                   Write the bundle to an explicit file path
  --since <timestamp>               Only include records on or after this time
  --submit                          Submit the bundle after writing it
  --endpoint <url>                  Override the default service endpoint
  --github                          Submit via GitHub flow instead of the service
  -h, --help                        Show this help`;
