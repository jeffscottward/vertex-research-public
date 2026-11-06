"use client";

// Academy theme scope: dark by default (owner request), light on demand. The choice is stored in this
// browser only and re-scopes the design tokens for the Academy subtree; charts use the matching palette.
import { type Palette, paletteFor } from "@darkfactory/academy/chart";
import { Moon, Sun } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const ACADEMY_THEME_STORAGE_KEY = "vertex-academy-theme";

type AcademyTheme = Readonly<{
  theme: "dark" | "light";
  palette: Palette;
  toggle: () => void;
}>;

const AcademyThemeContext = createContext<AcademyTheme>({
  theme: "dark",
  palette: paletteFor("dark"),
  toggle: () => undefined,
});

export const useAcademyTheme = (): AcademyTheme =>
  useContext(AcademyThemeContext);

export const AcademyThemeScope = ({
  children,
}: {
  readonly children: ReactNode;
}) => {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  // Storage can be blocked (privacy settings, sandboxed frames) or full; the in-memory theme still applies.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(ACADEMY_THEME_STORAGE_KEY) === "light")
        setTheme("light");
    } catch {
      return;
    }
  }, []);
  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(ACADEMY_THEME_STORAGE_KEY, next);
      } catch {
        // Keep the new theme for this page view only.
      }
      return next;
    });
  }, []);
  const value = useMemo(
    () => ({ theme, palette: paletteFor(theme), toggle }),
    [theme, toggle]
  );
  return (
    <AcademyThemeContext.Provider value={value}>
      <div
        className="-m-4 min-h-full bg-background p-4 text-foreground sm:-m-6 sm:p-6"
        data-academy-theme={theme}
        data-theme={theme === "dark" ? "default-dark" : "default-light"}
      >
        {children}
      </div>
    </AcademyThemeContext.Provider>
  );
};

export const AcademyThemeToggle = () => {
  const { theme, toggle } = useAcademyTheme();
  return (
    <button
      aria-label={
        theme === "dark"
          ? "Switch the Academy to light mode"
          : "Switch the Academy to dark mode"
      }
      className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      onClick={toggle}
      type="button"
    >
      <span aria-hidden="true" className="icon-swap">
        <Sun className="size-4" data-state={theme === "dark" ? "on" : "off"} />
        <Moon className="size-4" data-state={theme === "dark" ? "off" : "on"} />
      </span>
      {/* Both labels share one grid cell; the hidden one reserves the wider
          width, so the button keeps its size when the label changes. */}
      <span className="grid">
        <span className="col-start-1 row-start-1" data-academy-theme-label="">
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </span>
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          {theme === "dark" ? "Dark mode" : "Light mode"}
        </span>
      </span>
    </button>
  );
};
