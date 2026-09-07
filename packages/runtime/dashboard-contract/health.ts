import { Schema } from "effect";

export const HealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.String,
  version: Schema.String,
  latest_version: Schema.NullOr(Schema.String),
  update_available: Schema.Boolean,
  auto_update_supported: Schema.Boolean,
  update_hint: Schema.NullOr(Schema.String),
  pid: Schema.Number,
  runtime_instance_id: Schema.NullOr(Schema.String),
  runtime_owner: Schema.NullOr(Schema.Literals(["cli", "desktop"])),
  runtime_supervision: Schema.NullOr(Schema.Literals(["desktop-child", "none", "os-service"])),
  service_installation_nonce: Schema.NullOr(Schema.String),
  owner_executable_path: Schema.NullOr(Schema.String),
  spa: Schema.Boolean,
  spa_mode: Schema.optionalKey(Schema.Literals(["dist", "proxy", "missing"])),
  spa_build_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  spa_proxy_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  v2_data_available: Schema.Boolean,
  workspace_root: Schema.String,
  git_sha: Schema.String,
  db_path: Schema.String,
  log_dir: Schema.String,
  config_dir: Schema.String,
  watcher_mode: Schema.Literals(["wal", "jsonl", "none"]),
  process_mode: Schema.Literals(["standalone", "dev-server", "test"]),
  host: Schema.String,
  port: Schema.Number,
});

export type HealthResponse = typeof HealthResponse.Type;
