import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "dark" | "light" | "system";

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

const STORAGE_KEY = "selftune-theme";

export function ThemeProvider({
  children,
  defaultTheme: _defaultTheme = "dark",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    // Force dark mode — the Cognitive Loom design is dark-only
    const root = window.document.documentElement;
    root.classList.remove("light");
    root.classList.add("dark");
    localStorage.setItem(STORAGE_KEY, "dark");
  }, []);

  return (
    <ThemeProviderContext.Provider
      value={{
        theme,
        setTheme: (t: Theme) => {
          localStorage.setItem(STORAGE_KEY, t);
          setTheme(t);
        },
      }}
    >
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
}
