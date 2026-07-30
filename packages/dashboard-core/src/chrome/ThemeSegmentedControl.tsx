"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ToggleGroup, ToggleGroupItem } from "@selftune/ui/primitives";

import { useTheme, type Theme } from "./theme";

const THEME_OPTIONS: Array<{ value: Theme; label: string; icon: ReactNode }> = [
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
  { value: "system", label: "System", icon: <MonitorIcon /> },
];

export function ThemeSegmentedControl() {
  const { theme, setTheme } = useTheme();

  return (
    <ToggleGroup
      value={[theme]}
      aria-label="Color theme"
      onValueChange={(value) => {
        // Toggling the pressed item clears the group; keep the current theme.
        const next = value[0];
        if (next === "light" || next === "dark" || next === "system") setTheme(next);
      }}
    >
      {THEME_OPTIONS.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label}>
          {option.icon}
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
