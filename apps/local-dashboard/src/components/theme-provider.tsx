import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "dark" | "light" | "system";

interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

const STORAGE_KEY = "selftune-theme";
const VALID_THEMES: Theme[] = ["dark", "light", "system"];

function readStoredTheme(defaultTheme: Theme): Theme {
  const raw = localStorage.getItem(STORAGE_KEY);
  return VALID_THEMES.includes(raw as Theme) ? (raw as Theme) : defaultTheme;
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
}: {
  children: ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme(defaultTheme));

  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = (next: "dark" | "light") => {
      root.classList.remove("light", "dark");
      root.classList.add(next);
    };

    if (theme === "system") {
      const applySystemTheme = () => applyTheme(mediaQuery.matches ? "dark" : "light");
      applySystemTheme();
      mediaQuery.addEventListener("change", applySystemTheme);
      return () => mediaQuery.removeEventListener("change", applySystemTheme);
    }

    applyTheme(theme);
  }, [theme]);

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
