import { describe, expect, it } from "vitest";

import { alertTitleClassName, alertVariants } from "./alert.ts";

describe("alert styles", () => {
  it("uses the card surface by default and destructive tokens on request", () => {
    expect(alertVariants()).toContain("bg-card text-card-foreground");
    expect(alertVariants({ variant: "destructive" })).toContain(
      "border-destructive-border"
    );
    expect(alertVariants()).toContain("[&>p:not(.alert-title)]");
  });

  it("marks the title so the description rule skips it", () => {
    expect(alertTitleClassName.split(" ")).toContain("alert-title");
  });
});
