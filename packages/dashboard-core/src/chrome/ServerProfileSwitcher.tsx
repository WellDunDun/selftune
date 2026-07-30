"use client";

import {
  CheckIcon,
  ChevronDownIcon,
  CloudIcon,
  ExternalLinkIcon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@selftune/ui/primitives";

import type { ServerProfile, ServerProfileController } from "../host/server-profiles";
import type { DashboardCloudProfileConnection } from "./types";

export function serverProfileStatusLabel(
  profile: ServerProfile,
  cloudConnection?: DashboardCloudProfileConnection,
): string {
  if (profile.kind !== "cloud" || !cloudConnection) {
    return profile.status.state === "ready" ? "Ready" : "Check";
  }
  switch (cloudConnection.state) {
    case "checking":
      return "Checking…";
    case "unlinked":
      return "Connect";
    case "connecting":
      return "Connecting…";
    case "linked":
      return "Connected";
    case "unavailable":
      return "Retry";
  }
}

export async function activateServerProfile(
  controller: Pick<ServerProfileController, "select">,
  profile: ServerProfile,
  cloudConnection?: DashboardCloudProfileConnection,
): Promise<void> {
  if (profile.kind === "cloud" && cloudConnection) {
    if (cloudConnection.state === "unlinked" || cloudConnection.state === "unavailable") {
      await cloudConnection.connect();
    } else if (cloudConnection.state === "linked") {
      cloudConnection.manage();
    }
    return;
  }
  await controller.select(profile.id);
}

export function ServerProfileSwitcher({
  controller,
  cloudConnection,
}: {
  controller: ServerProfileController;
  cloudConnection?: DashboardCloudProfileConnection;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const active =
    snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId) ??
    snapshot.profiles[0];
  const [managing, setManaging] = useState(false);
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  if (!active) return null;
  const selectableProfiles = cloudConnection
    ? snapshot.profiles.filter((profile) => profile.kind !== "cloud")
    : snapshot.profiles;
  const cloudProfile = cloudConnection
    ? snapshot.profiles.find((profile) => profile.kind === "cloud")
    : undefined;

  const run = async (operation: () => void | Promise<void>): Promise<void> => {
    setMessage(null);
    try {
      await operation();
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "The server profile could not be changed.",
      );
    }
  };

  return (
    <div className="desktop-macos-no-drag flex flex-col gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" className="h-auto w-full justify-start px-2 py-1.5 text-left" />
          }
        >
          <ServerIcon data-icon="inline-start" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{active.name}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {active.kind === "local"
                ? "Local"
                : active.kind === "cloud"
                  ? "Cloud"
                  : "Self-hosted"}
            </span>
          </span>
          <ChevronDownIcon data-icon="inline-end" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Server profiles</DropdownMenuLabel>
            {selectableProfiles.map((profile) => (
              <DropdownMenuItem
                key={profile.id}
                onClick={() =>
                  void run(() => activateServerProfile(controller, profile, cloudConnection))
                }
              >
                {profile.id === active.id ? (
                  <CheckIcon />
                ) : profile.kind === "cloud" ? (
                  <CloudIcon />
                ) : (
                  <ServerIcon />
                )}
                <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                <span className="text-xs text-muted-foreground">
                  {serverProfileStatusLabel(profile, cloudConnection)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {cloudProfile && cloudConnection ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Cloud account</DropdownMenuLabel>
                <DropdownMenuItem
                  disabled={
                    cloudConnection.state === "checking" || cloudConnection.state === "connecting"
                  }
                  onClick={() =>
                    void run(() => activateServerProfile(controller, cloudProfile, cloudConnection))
                  }
                >
                  <CloudIcon />
                  <span className="min-w-0 flex-1 truncate">{cloudProfile.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {serverProfileStatusLabel(cloudProfile, cloudConnection)}
                  </span>
                </DropdownMenuItem>
                {cloudConnection.state === "linked" ? (
                  <DropdownMenuItem onClick={() => void run(cloudConnection.openDashboard)}>
                    <ExternalLinkIcon /> Open Cloud dashboard
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => setManaging((value) => !value)}>
              <PlusIcon /> Manage servers
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {managing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/20 p-2">
          <p className="text-xs font-medium text-sidebar-foreground">Add self-hosted server</p>
          <Input
            aria-label="Server name"
            placeholder="Server name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            aria-label="Server URL"
            placeholder="https://selftune.example.com"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
          <Input
            aria-label="Session API key"
            type="password"
            placeholder="Session-only API key"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
          <Button
            size="sm"
            onClick={() =>
              void run(async () => {
                await controller.add(
                  {
                    id: `selfhost:${crypto.randomUUID()}`,
                    kind: "selfhost",
                    name,
                    origin,
                    authentication: { kind: "bearer_session" },
                    capabilities: active.capabilities,
                  },
                  credential,
                );
                setName("");
                setOrigin("");
                setCredential("");
              })
            }
          >
            <PlusIcon data-icon="inline-start" /> Add and test
          </Button>
          {snapshot.profiles
            .filter((profile) => !profile.system && !(cloudConnection && profile.kind === "cloud"))
            .map((profile) => (
              <div key={profile.id} className="flex items-center gap-1">
                <Input
                  aria-label={`Rename ${profile.name}`}
                  defaultValue={profile.name}
                  onBlur={(event) => {
                    if (event.currentTarget.value !== profile.name)
                      void run(() => controller.rename(profile.id, event.currentTarget.value));
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Test ${profile.name}`}
                  onClick={() =>
                    void run(async () => {
                      await controller.test(profile.id);
                    })
                  }
                >
                  <ServerIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${profile.name}`}
                  onClick={() => void run(() => controller.remove(profile.id))}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
          {message ? <Badge variant="destructive">{message}</Badge> : null}
        </div>
      ) : null}
    </div>
  );
}
