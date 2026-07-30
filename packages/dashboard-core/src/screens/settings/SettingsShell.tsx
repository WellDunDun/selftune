"use client";

import type { ReactNode } from "react";

import { PageHeader, PageScaffold } from "@selftune/ui/components";
import { Tabs, TabsList, TabsTrigger } from "@selftune/ui/primitives";

export interface SettingsShellSection<T extends string> {
  id: T;
  label: string;
}

export interface SettingsShellProps<T extends string> {
  /** The settings areas this host makes available. */
  sections: readonly SettingsShellSection<T>[];
  /** The selected section. Its matching TabsContent is supplied by the host. */
  activeSection: T;
  /** Called after a user chooses another available settings section. */
  onSectionChange(value: T): void;
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}

/**
 * Shared settings information architecture for every product host.
 *
 * Hosts own section availability, state, and content. This shell owns the
 * desktop-first header and responsive, semantic settings navigation.
 */
export function SettingsShell<T extends string>({
  sections,
  activeSection,
  onSectionChange,
  title = "Settings",
  description,
  children,
}: SettingsShellProps<T>) {
  return (
    <PageScaffold data-slot="settings-shell" className="max-w-6xl gap-8">
      <PageHeader title={title} description={description} />
      <Tabs
        value={activeSection}
        orientation="vertical"
        className="grid min-w-0 items-start gap-8 lg:grid-cols-[160px_minmax(0,1fr)]"
        onValueChange={(value) => {
          const section = sections.find((candidate) => candidate.id === value);
          if (section) onSectionChange(section.id);
        }}
      >
        <aside
          data-slot="settings-shell-rail"
          className="border-b border-border/60 pb-5 lg:border-r lg:border-b-0 lg:pr-5 lg:pb-0"
        >
          <nav aria-label="Settings tabs">
            <TabsList variant="line" className="w-full items-stretch">
              {sections.map((section) => (
                <TabsTrigger key={section.id} value={section.id}>
                  {section.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </nav>
        </aside>
        <div data-slot="settings-shell-content" className="min-w-0">
          {children}
        </div>
      </Tabs>
    </PageScaffold>
  );
}
