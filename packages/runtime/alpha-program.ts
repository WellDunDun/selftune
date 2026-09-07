import * as Effect from "effect/Effect";
import { loadConfigSync } from "@selftune/config";

import { generateUserId, readAlphaIdentity } from "./alpha-identity.js";
import {
  buildVerificationUrl,
  pollDeviceCode,
  requestDeviceCode,
  tryOpenUrl,
  type DeviceCodeGrant,
  type DeviceCodeResult,
} from "./auth/device-code.js";
import { hasCloudCredentialMetadata, persistCloudCredential } from "./auth/cloud-credential.js";
import { SELFTUNE_CONFIG_PATH } from "./constants.js";
import type { AlphaIdentity } from "./types.js";
import { CLIError } from "./utils/cli-error.js";

export interface AlphaRelinkResult {
  readonly level: "info";
  readonly code: "alpha_relinked";
  readonly replaced_existing_key: boolean;
  readonly cloud_user_id: string;
  readonly message: string;
}

export interface AlphaRelinkDependencies {
  readonly readIdentity: () => AlphaIdentity | null;
  readonly requestDeviceCode: () => Promise<DeviceCodeGrant>;
  readonly buildVerificationUrl: (verificationUrl: string, userCode: string) => string;
  readonly openVerificationUrl: (url: string) => boolean;
  readonly pollDeviceCode: (
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ) => Promise<DeviceCodeResult>;
  readonly generateUserId: () => string;
  readonly now: () => string;
  readonly persistIdentity: (identity: AlphaIdentity, apiKey: string) => AlphaIdentity;
  readonly writeStdout: (output: string) => void;
  readonly writeStderr: (output: string) => void;
}

const liveAlphaRelinkDependencies: AlphaRelinkDependencies = {
  readIdentity: () => readAlphaIdentity(SELFTUNE_CONFIG_PATH),
  requestDeviceCode,
  buildVerificationUrl,
  openVerificationUrl: tryOpenUrl,
  pollDeviceCode,
  generateUserId,
  now: () => new Date().toISOString(),
  persistIdentity: (identity, apiKey) => {
    const config = loadConfigSync(SELFTUNE_CONFIG_PATH);
    if (!config) throw new Error("Cannot relink alpha before selftune is initialized.");
    config.alpha = { ...identity, credential: config.alpha?.credential };
    const persisted = persistCloudCredential(config, apiKey, {
      configPath: SELFTUNE_CONFIG_PATH,
    });
    if (!persisted.config.alpha) throw new Error("Alpha identity was not persisted.");
    return persisted.config.alpha;
  },
  writeStdout: (output) => process.stdout.write(`${output}\n`),
  writeStderr: (output) => process.stderr.write(output),
};

function toAlphaCliError(cause: unknown, suggestion: string): CLIError {
  return cause instanceof CLIError
    ? cause
    : new CLIError(
        cause instanceof Error ? cause.message : String(cause),
        "OPERATION_FAILED",
        suggestion,
      );
}

function tryAlphaSync<A>(operation: () => A, suggestion: string): Effect.Effect<A, CLIError> {
  return Effect.try({
    try: operation,
    catch: (cause) => toAlphaCliError(cause, suggestion),
  });
}

export const runAlphaRelinkProgram = Effect.fn("selftune.alpha.relink")(function* (
  dependencies: AlphaRelinkDependencies = liveAlphaRelinkDependencies,
) {
  const existingIdentity = yield* tryAlphaSync(dependencies.readIdentity, "selftune alpha relink");
  yield* tryAlphaSync(
    () => dependencies.writeStderr("[alpha relink] Starting device-code authentication flow...\n"),
    "selftune alpha relink",
  );

  const grant = yield* Effect.tryPromise({
    try: dependencies.requestDeviceCode,
    catch: (cause) => toAlphaCliError(cause, "selftune alpha relink"),
  });
  const verificationUrlWithCode = yield* tryAlphaSync(
    () => dependencies.buildVerificationUrl(grant.verification_url, grant.user_code),
    "selftune alpha relink",
  );
  yield* tryAlphaSync(() => {
    dependencies.writeStdout(
      JSON.stringify({
        level: "info",
        code: "device_code_issued",
        verification_url: grant.verification_url,
        verification_url_with_code: verificationUrlWithCode,
        user_code: grant.user_code,
        expires_in: grant.expires_in,
        message: `Open ${verificationUrlWithCode} to approve.`,
      }),
    );
    dependencies.writeStderr(
      dependencies.openVerificationUrl(verificationUrlWithCode)
        ? "[alpha relink] Browser opened. Waiting for approval...\n"
        : `[alpha relink] Could not open browser. Visit ${verificationUrlWithCode} manually.\n`,
    );
    dependencies.writeStderr("[alpha relink] Polling");
  }, "selftune alpha relink");

  const deviceResult = yield* Effect.tryPromise({
    try: () => dependencies.pollDeviceCode(grant.device_code, grant.interval, grant.expires_in),
    catch: (cause) => toAlphaCliError(cause, "selftune alpha relink"),
  });
  yield* tryAlphaSync(
    () => dependencies.writeStderr("\n[alpha relink] Approved!\n"),
    "selftune alpha relink",
  );

  const updatedIdentity = yield* tryAlphaSync<AlphaIdentity>(
    () => ({
      enrolled: true,
      user_id: existingIdentity?.user_id ?? dependencies.generateUserId(),
      cloud_user_id: deviceResult.cloud_user_id,
      cloud_org_id: deviceResult.org_id,
      email: existingIdentity?.email,
      display_name: existingIdentity?.display_name,
      consent_timestamp: dependencies.now(),
    }),
    "selftune alpha relink",
  );
  yield* tryAlphaSync(
    () => dependencies.persistIdentity(updatedIdentity, deviceResult.api_key),
    "selftune alpha relink",
  );

  const result: AlphaRelinkResult = {
    level: "info",
    code: "alpha_relinked",
    replaced_existing_key: hasCloudCredentialMetadata(existingIdentity),
    cloud_user_id: deviceResult.cloud_user_id,
    message: "Successfully relinked. Old key revoked by cloud during approval.",
  };
  yield* tryAlphaSync(
    () => dependencies.writeStdout(JSON.stringify(result)),
    "selftune alpha relink",
  );
  return result;
});
