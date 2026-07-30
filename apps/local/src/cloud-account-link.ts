import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { loadConfigSync } from "@selftune/config";
import {
  beginCloudAccountLink,
  completeCloudAccountLink,
} from "@selftune/orchestration/setup/link-account";
import { pollDeviceCode, requestDeviceCode } from "@selftune/runtime/auth/device-code";
import type {
  CompleteCloudAccountLinkRequest,
  CompleteCloudAccountLinkResponse,
  DesktopSettingsResponse,
  StartCloudAccountLinkResponse,
} from "@selftune/runtime/dashboard-contract";
import { activateCloudRemoteLibraryConfig } from "@selftune/runtime/remote-library-config";
import { CLIError } from "@selftune/runtime/utils/cli-error";
import { LibraryError } from "@selftune/library";

import { desktopCloudClientId } from "./cloud-account-client.js";

interface PendingCloudAccountLink {
  readonly clientId: string;
  readonly expiresAt: number;
  readonly grant: Awaited<ReturnType<typeof beginCloudAccountLink>>["grant"];
}

export interface CloudAccountLinkManagerOptions {
  readonly completeOverride?: (
    input: CompleteCloudAccountLinkRequest,
  ) => CompleteCloudAccountLinkResponse | Promise<CompleteCloudAccountLinkResponse>;
  readonly configRoot: string;
  readonly loadSettings: () => DesktopSettingsResponse | Promise<DesktopSettingsResponse>;
  readonly startOverride?: () =>
    | StartCloudAccountLinkResponse
    | Promise<StartCloudAccountLinkResponse>;
  readonly sync: () => unknown | Promise<unknown>;
}

function transport(clientId: string) {
  return {
    requestDeviceCode: () => requestDeviceCode(clientId),
    pollDeviceCode: (deviceCode: string, interval: number, expiresIn: number) =>
      pollDeviceCode(deviceCode, interval, expiresIn, clientId),
  };
}

export function makeCloudAccountLinkManager(options: CloudAccountLinkManagerOptions) {
  const pendingLinks = new Map<string, PendingCloudAccountLink>();

  const start = async (): Promise<StartCloudAccountLinkResponse> => {
    if (options.startOverride) return options.startOverride();
    const now = Date.now();
    for (const [linkId, pending] of pendingLinks) {
      if (pending.expiresAt <= now) pendingLinks.delete(linkId);
    }
    try {
      const clientId = desktopCloudClientId(options.configRoot);
      const { grant, verificationUrlWithCode } = await beginCloudAccountLink({
        transport: transport(clientId),
      });
      const linkId = randomUUID();
      const expiresAt = now + grant.expires_in * 1_000;
      pendingLinks.set(linkId, { clientId, grant, expiresAt });
      return {
        link_id: linkId,
        verification_url: verificationUrlWithCode,
        user_code: grant.user_code,
        expires_at: new Date(expiresAt).toISOString(),
      };
    } catch (cause) {
      throw new CLIError(
        cause instanceof Error ? cause.message : "Could not start Cloud account linking.",
        "API_ERROR",
        "Check your connection and try again.",
        1,
        true,
      );
    }
  };

  const complete = async (
    input: CompleteCloudAccountLinkRequest,
  ): Promise<CompleteCloudAccountLinkResponse> => {
    if (options.completeOverride) return options.completeOverride(input);
    const pending = pendingLinks.get(input.link_id);
    if (!pending) {
      throw new CLIError(
        "This Cloud account link is no longer active.",
        "NOT_FOUND",
        "Start the Cloud connection again.",
      );
    }
    if (pending.expiresAt <= Date.now()) {
      pendingLinks.delete(input.link_id);
      throw new CLIError(
        "The Cloud account link expired.",
        "OPERATION_FAILED",
        "Start the Cloud connection again.",
        1,
        true,
      );
    }

    const configPath = join(options.configRoot, "config.json");
    try {
      const config =
        loadConfigSync(configPath) ??
        ({
          agent_type: "unknown",
          cli_path: "",
          llm_mode: "agent",
          agent_cli: null,
          hooks_installed: false,
          initialized_at: new Date().toISOString(),
        } as const);
      await completeCloudAccountLink({ configPath, config }, pending.grant, {
        configRoot: options.configRoot,
        transport: transport(pending.clientId),
      });
      activateCloudRemoteLibraryConfig(input.preferences, options.configRoot);

      let firstBackup: CompleteCloudAccountLinkResponse["first_backup"];
      try {
        const result = (await options.sync()) as { uploaded?: unknown; unchanged?: unknown };
        firstBackup = {
          status: "completed",
          uploaded: typeof result?.uploaded === "number" ? result.uploaded : 0,
          unchanged: typeof result?.unchanged === "number" ? result.unchanged : 0,
        };
      } catch (cause) {
        firstBackup = {
          status: "failed",
          message: cause instanceof Error ? cause.message : "The first backup failed.",
        };
      }
      return { settings: await options.loadSettings(), first_backup: firstBackup };
    } catch (cause) {
      if (cause instanceof CLIError || cause instanceof LibraryError) throw cause;
      throw new CLIError(
        cause instanceof Error ? cause.message : "Cloud account linking failed.",
        "OPERATION_FAILED",
        "Start the Cloud connection again.",
      );
    } finally {
      pendingLinks.delete(input.link_id);
    }
  };

  return { start, complete } as const;
}
