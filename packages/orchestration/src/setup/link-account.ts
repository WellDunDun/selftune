import { loadConfigSync, type SelftuneConfig } from "@selftune/config";
import { generateUserId, isValidApiKeyFormat } from "@selftune/runtime/alpha-identity";
import {
  buildVerificationUrl,
  pollDeviceCode,
  requestDeviceCode,
  type DeviceCodeGrant,
  type DeviceCodeResult,
} from "@selftune/runtime/auth/device-code";
import {
  persistCloudCredential,
  persistCloudCredentialAsync,
  type AsyncCloudCredentialDependencies,
  type CloudCredentialDependencies,
} from "@selftune/runtime/auth/cloud-credential";

export interface DeviceCodeTransport {
  readonly requestDeviceCode: () => Promise<DeviceCodeGrant>;
  readonly pollDeviceCode: (
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ) => Promise<DeviceCodeResult>;
}

export interface LinkCloudAccountEvents {
  readonly deviceCodeIssued?: (
    grant: DeviceCodeGrant,
    verificationUrlWithCode: string,
  ) => void | Promise<void>;
  readonly pollingStarted?: (
    grant: DeviceCodeGrant,
    verificationUrlWithCode: string,
  ) => void | Promise<void>;
  readonly approved?: (result: DeviceCodeResult) => void | Promise<void>;
}

export interface LinkCloudAccountDependencies extends CloudCredentialDependencies {
  readonly asyncCredentialStore?: AsyncCloudCredentialDependencies["credentialStore"];
  readonly transport?: DeviceCodeTransport;
  readonly buildVerificationUrl?: (verificationUrl: string, userCode: string) => string;
  readonly generateUserId?: () => string;
  readonly now?: () => Date;
  readonly events?: LinkCloudAccountEvents;
}

export interface LinkCloudAccountInput {
  readonly configPath: string;
  readonly config?: SelftuneConfig;
  readonly email?: string;
  readonly displayName?: string;
}

export interface LinkCloudAccountResult {
  readonly config: SelftuneConfig;
  readonly grant: DeviceCodeGrant;
  readonly deviceResult: DeviceCodeResult;
}

export interface BeginCloudAccountLinkResult {
  readonly grant: DeviceCodeGrant;
  readonly verificationUrlWithCode: string;
}

function validateApprovedCredential(result: DeviceCodeResult): void {
  if (!isValidApiKeyFormat(result.api_key)) {
    throw new Error(
      "Device-code approval returned an invalid alpha credential. Re-run `selftune init --alpha`.",
    );
  }
  if (!result.cloud_user_id?.trim()) {
    throw new Error(
      "Device-code approval did not include a cloud user id. Re-run `selftune init --alpha`.",
    );
  }
  if (!result.org_id?.trim()) {
    throw new Error(
      "Device-code approval did not include an alpha org id. Re-run `selftune init --alpha`.",
    );
  }
}

export async function beginCloudAccountLink(
  deps: LinkCloudAccountDependencies = {},
): Promise<BeginCloudAccountLinkResult> {
  const transport = deps.transport ?? { requestDeviceCode, pollDeviceCode };
  const grant = await transport.requestDeviceCode();
  const verificationUrlWithCode = (deps.buildVerificationUrl ?? buildVerificationUrl)(
    grant.verification_url,
    grant.user_code,
  );
  await deps.events?.deviceCodeIssued?.(grant, verificationUrlWithCode);
  return { grant, verificationUrlWithCode };
}

export async function completeCloudAccountLink(
  input: LinkCloudAccountInput,
  grant: DeviceCodeGrant,
  deps: LinkCloudAccountDependencies = {},
): Promise<LinkCloudAccountResult> {
  let storedConfig: SelftuneConfig | null = null;
  try {
    storedConfig = loadConfigSync(input.configPath);
  } catch {
    // A force-init caller may intentionally replace a corrupt config with input.config.
  }
  const config = structuredClone(input.config ?? storedConfig);
  if (!config) throw new Error("Cloud linking requires an initialized selftune config.");

  const transport = deps.transport ?? { requestDeviceCode, pollDeviceCode };
  const verificationUrlWithCode = (deps.buildVerificationUrl ?? buildVerificationUrl)(
    grant.verification_url,
    grant.user_code,
  );
  await deps.events?.pollingStarted?.(grant, verificationUrlWithCode);
  const deviceResult = await transport.pollDeviceCode(
    grant.device_code,
    grant.interval,
    grant.expires_in,
  );
  validateApprovedCredential(deviceResult);
  await deps.events?.approved?.(deviceResult);

  const existingIdentity = storedConfig?.alpha ?? config.alpha;
  config.alpha = {
    enrolled: true,
    user_id: existingIdentity?.user_id ?? (deps.generateUserId ?? generateUserId)(),
    cloud_user_id: deviceResult.cloud_user_id,
    cloud_org_id: deviceResult.org_id,
    cloud_api_url: existingIdentity?.cloud_api_url,
    email: input.email ?? existingIdentity?.email,
    display_name: input.displayName ?? existingIdentity?.display_name,
    consent_timestamp: (deps.now ?? (() => new Date()))().toISOString(),
    credential: existingIdentity?.credential,
  };

  const persisted = deps.credentialStore
    ? persistCloudCredential(config, deviceResult.api_key, {
        configPath: input.configPath,
        configRoot: deps.configRoot,
        credentialStore: deps.credentialStore,
        writeConfig: deps.writeConfig,
      })
    : await persistCloudCredentialAsync(config, deviceResult.api_key, {
        credentialStore: deps.asyncCredentialStore,
        configPath: input.configPath,
        configRoot: deps.configRoot,
        writeConfig: deps.writeConfig,
      });
  return { config: persisted.config, grant, deviceResult };
}

export async function linkCloudAccount(
  input: LinkCloudAccountInput,
  deps: LinkCloudAccountDependencies = {},
): Promise<LinkCloudAccountResult> {
  const { grant } = await beginCloudAccountLink(deps);
  return completeCloudAccountLink(input, grant, deps);
}
