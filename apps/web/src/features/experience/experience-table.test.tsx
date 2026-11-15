import { TableBody, TableRow } from "@darkfactory/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExperienceTable,
  ExperienceTableCaption,
  ExperienceTableCell,
  ExperienceTableHead,
  ExperienceTableHeader,
  experienceTableScroll,
} from "./experience-table.tsx";

const html = renderToStaticMarkup(
  <div className={experienceTableScroll}>
    <ExperienceTable aria-label="Synthetic records">
      <ExperienceTableCaption>Synthetic caption</ExperienceTableCaption>
      <ExperienceTableHeader>
        <TableRow>
          <ExperienceTableHead scope="col">Name</ExperienceTableHead>
          <ExperienceTableHead numeric scope="col">
            Count
          </ExperienceTableHead>
        </TableRow>
      </ExperienceTableHeader>
      <TableBody>
        <TableRow>
          <ExperienceTableHead scope="row">synthetic-row</ExperienceTableHead>
          <ExperienceTableCell numeric>9007199254740993</ExperienceTableCell>
        </TableRow>
        <TableRow>
          <ExperienceTableHead scope="row">long-row</ExperienceTableHead>
          <ExperienceTableCell>wrapping text</ExperienceTableCell>
        </TableRow>
      </TableBody>
    </ExperienceTable>
  </div>
);

describe("experience record table", () => {
  it("lets the outer region scroll and puts the caption above the table", () => {
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain('class="relative w-full overflow-visible"');
    return expect(html).toMatch(
      /<caption class="[^"]*caption-top[^"]*" data-slot="table-caption">Synthetic caption<\/caption>/u
    );
  });

  it("wraps and top-aligns every cell, including row headers", () => {
    const cells = Array.from(
      html.matchAll(/<(th|td) class="([^"]*)"[^>]*>([^<]*)<\/\1>/gu)
    );
    expect(cells).toHaveLength(6);
    for (const [, , classes, text] of cells) {
      expect(classes, text).toMatch(/(?<![\w:-])h-auto(?![\w-])/u);
      expect(classes, text).toMatch(/(?<![\w:-])align-top(?![\w-])/u);
    }
    return expect(html).not.toContain("h-10");
  });

  it("marks only numeric cells, which stay on one line and align right", () => {
    const numeric = Array.from(
      html.matchAll(
        /<(th|td) class="([^"]*)"[^>]*data-numeric=""[^>]*>([^<]*)</gu
      )
    ).map(([, tag, classes, text]) => [tag, text, classes]);
    expect(numeric.map(([tag, text]) => [tag, text])).toEqual([
      ["th", "Count"],
      ["td", "9007199254740993"],
    ]);
    for (const [, , classes] of numeric) {
      expect(classes).toContain("whitespace-nowrap");
      expect(classes).toContain("text-right");
      expect(classes).not.toContain("whitespace-normal");
    }
    return expect(html).toMatch(
      /<td class="[^"]*whitespace-normal[^"]*" data-slot="table-cell">wrapping text<\/td>/u
    );
  });
});
