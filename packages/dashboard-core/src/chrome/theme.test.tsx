// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./theme";

function ThemeControl() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <button onClick={() => setTheme("dark")}>
      {theme}:{resolvedTheme}
    </button>
  );
}

beforeEach(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  } satisfies Storage);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses light for system theme without matchMedia and persists explicit changes", () => {
  render(
    <ThemeProvider defaultTheme="system">
      <ThemeControl />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "system:light" }));
  expect(screen.getByRole("button", { name: "dark:dark" })).toBeTruthy();
  expect(window.localStorage.getItem("selftune-theme")).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("ignores invalid stored themes and tolerates inaccessible storage", () => {
  window.localStorage.setItem("selftune-theme", "broken");
  const view = render(
    <ThemeProvider>
      <ThemeControl />
    </ThemeProvider>,
  );
  expect(screen.getByRole("button", { name: "light:light" })).toBeTruthy();
  view.unmount();
  vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(
    <ThemeProvider>
      <ThemeControl />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "light:light" }));
  expect(screen.getByRole("button", { name: "dark:dark" })).toBeTruthy();
});
