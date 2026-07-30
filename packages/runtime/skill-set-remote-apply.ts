import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { SELFTUNE_CONFIG_DIR } from "./constants.js";
import { loadRemoteLibraryConfig } from "./remote-library/config.js";
import {
  createRemoteLibraryHandle,
  type RemoteLibraryHandle,
} from "@selftune/library/remote/transport";
import { materializeSkillSetDependencies } from "./remote-library-sync.js";
import {
  applySkillSet,
  LibraryError,
  listWorkspaceSkillSetPolicies,
  listMissingSkillSetDependencies,
  planSkillSet,
  type SkillSetReceipt,
  type SkillSetServiceOptions,
} from "@selftune/library";
import type { WorkspaceMemberRole, WorkspaceSkillSetPolicy } from "@selftune/library/remote/types";

export interface SkillSetRemoteApplyResult extends SkillSetReceipt {
  dependencies_downloaded: number;
}

const POLICY_CACHE_FILE = "workspace-skill-set-policies.json";

export function enforceWorkspaceSkillSetPolicy(
  policy: WorkspaceSkillSetPolicy | null,
  approved: boolean,
  currentRole?: WorkspaceMemberRole | null,
): void {
  if (policy && currentRole === "viewer") {
    throw new LibraryError(
      `Viewer access cannot apply ${policy.skill_set_name}.`,
      "GUARD_BLOCKED",
      "Ask a workspace admin to grant Member access before installing Workspace Skill Sets.",
    );
  }
  if (!policy || policy.action === "allow" || policy.action === "require") return;
  if (policy.action === "block") {
    throw new LibraryError(
      policy.reason || `Your workspace has blocked ${policy.skill_set_name}.`,
      "GUARD_BLOCKED",
      "Ask a workspace admin to change the Skill Set policy.",
    );
  }
  if (!approved) {
    throw new LibraryError(
      `Workspace approval is required before applying ${policy.skill_set_name}.`,
      "GUARD_BLOCKED",
      policy.reason || "Review the installation plan, then confirm this workspace action.",
    );
  }
}

function policyCachePath(configRoot: string): string {
  return resolve(configRoot, POLICY_CACHE_FILE);
}

interface WorkspacePolicyCache {
  policies: WorkspaceSkillSetPolicy[];
  currentRole: WorkspaceMemberRole | null;
}

function readPolicyCache(configRoot: string): WorkspacePolicyCache {
  const path = policyCachePath(configRoot);
  if (!existsSync(path)) return { policies: [], currentRole: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      policies?: WorkspaceSkillSetPolicy[];
      current_role?: WorkspaceMemberRole;
    };
    return {
      policies: Array.isArray(value.policies) ? value.policies : [],
      currentRole: value.current_role ?? null,
    };
  } catch {
    return { policies: [], currentRole: null };
  }
}

export function writeWorkspaceSkillSetPolicyCache(
  configRoot: string,
  policies: WorkspaceSkillSetPolicy[],
  currentRole?: WorkspaceMemberRole | null,
): void {
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    policyCachePath(configRoot),
    `${JSON.stringify({ schema_version: 1, current_role: currentRole ?? null, policies }, null, 2)}\n`,
    "utf8",
  );
}

async function resolvePolicy(
  skillSetId: string,
  configRoot: string,
): Promise<{ policy: WorkspaceSkillSetPolicy | null; currentRole: WorkspaceMemberRole | null }> {
  let cached = readPolicyCache(configRoot);
  try {
    const config = loadRemoteLibraryConfig(configRoot);
    const response = await listWorkspaceSkillSetPolicies({
      url: config.url,
      apiKey: config.apiKey,
    });
    cached = { policies: response.policies, currentRole: response.current_role };
    writeWorkspaceSkillSetPolicyCache(configRoot, cached.policies, cached.currentRole);
  } catch {
    // Local-first fallback: keep enforcing the last policy this device successfully verified.
  }
  return {
    policy: cached.policies.find((policy) => policy.skill_set_id === skillSetId) ?? null,
    currentRole: cached.currentRole,
  };
}

export async function applySkillSetWithRemoteDependencies(
  input: {
    set_id: string;
    project_root: string;
    harnesses?: ReadonlyArray<string>;
    policy_approval?: boolean;
  },
  options: SkillSetServiceOptions & { remoteHandle?: RemoteLibraryHandle } = {},
): Promise<SkillSetRemoteApplyResult> {
  const configRoot = resolve(options.configRoot ?? SELFTUNE_CONFIG_DIR);
  const workspaceAccess = await resolvePolicy(input.set_id, configRoot);
  enforceWorkspaceSkillSetPolicy(
    workspaceAccess.policy,
    input.policy_approval === true,
    workspaceAccess.currentRole,
  );
  const plan = planSkillSet(input, options);
  if (plan.conflicts > 0) {
    return { ...applySkillSet(input, options), dependencies_downloaded: 0 };
  }

  const dependencies = listMissingSkillSetDependencies(input.set_id, options);
  if (dependencies.length === 0) {
    return { ...applySkillSet(input, options), dependencies_downloaded: 0 };
  }

  const ownedHandle = options.remoteHandle
    ? null
    : createRemoteLibraryHandle(
        (() => {
          const config = loadRemoteLibraryConfig(configRoot);
          return { baseUrl: config.url, apiKey: config.apiKey };
        })(),
      );
  const handle = options.remoteHandle ?? ownedHandle;
  if (!handle) throw new Error("Sync & Backup connection was not initialized.");
  try {
    const materialized = await materializeSkillSetDependencies({
      handle,
      configRoot,
      dependencies,
    });
    return {
      ...applySkillSet(input, options),
      dependencies_downloaded: materialized.downloaded,
    };
  } finally {
    if (ownedHandle) await ownedHandle.dispose();
  }
}
