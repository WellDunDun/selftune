export const LIBRARY_HELP = `selftune library — Reconcile and back up the local-first Skill Library

Usage:
  selftune library
  selftune library configure --url <remote-url> --api-key <device-key>
  selftune library preview
  selftune library sync
  selftune library status
  selftune library diagnostics
  selftune library export --output <backup.json>
  selftune library restore --target <clean-config-directory>
  selftune library synthesize scan
  selftune library synthesize list
  selftune library synthesize review --candidate-id <id> --action <accept|reject|snooze|edit> --reason <text>
  selftune library synthesize draft --candidate-id <id> [--output-dir <directory>]
  selftune library synthesize evaluate --candidate-id <id>
  selftune library synthesize release --candidate-id <id>`;
