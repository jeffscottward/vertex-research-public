// What: Color palettes shared by the interactive chart, the captions and the rendered video.
// One token (green, red, ...) maps to one color per theme, so a caption and its drawn element match.
import type { ColorToken } from "../schema.ts";

export type Palette = Readonly<{
  name: "dark" | "light";
  background: string;
  panel: string;
  grid: string;
  axis: string;
  text: string;
  muted: string;
  tokens: Readonly<Record<ColorToken, string>>;
}>;

export const DARK_PALETTE: Palette = {
  name: "dark",
  background: "#0e1014",
  panel: "#141820",
  grid: "#262c37",
  axis: "#4a5262",
  text: "#eceef2",
  muted: "#9aa3b2",
  tokens: {
    green: "#22c55e",
    red: "#f05252",
    blue: "#4f8ff7",
    amber: "#f5a524",
    violet: "#a78bfa",
    cyan: "#22d3ee",
    gold: "#d6b44c",
    gray: "#a3acba",
  },
};

export const LIGHT_PALETTE: Palette = {
  name: "light",
  background: "#ffffff",
  panel: "#f8f9fb",
  grid: "#e4e7ec",
  axis: "#98a2b3",
  text: "#101828",
  muted: "#475467",
  tokens: {
    green: "#15803d",
    red: "#c81e1e",
    blue: "#1d4ed8",
    amber: "#b45309",
    violet: "#6d28d9",
    cyan: "#0e7490",
    gold: "#8a6d0b",
    gray: "#5b6575",
  },
};

export const paletteFor = (theme: "dark" | "light"): Palette =>
  theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
