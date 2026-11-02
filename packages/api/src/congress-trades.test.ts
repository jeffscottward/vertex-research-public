import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  CongressIndexError,
  decodeXmlText,
  distinctMembers,
  filingWindow,
  houseIndexUrl,
  type IndexFiling,
  indexXmlFromBytes,
  isoFromMdy,
  parseFilingIndex,
  ptrPdfUrl,
  readZipXml,
  selectPtrFilings,
  windowYears,
} from "./congress-trades.ts";

// 2026FD.zip is the upstream day-trader-skill fixture (MIT, see fixtures/day-trader-skill/NOTICE.md):
// a trimmed House Clerk index with 16 members, 13 of them PTRs.
const FIXTURE = new Uint8Array(
  readFileSync(
    new URL(
      "./fixtures/day-trader-skill/trader-pelosi/2026FD.zip",
      import.meta.url
    )
  )
);
const MAX = 1024 * 1024;
const encoder = new TextEncoder();

type ZipFile = Readonly<{
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  size?: number;
}>;

/** A minimal ZIP (local headers, central directory, end record) for edge cases. */
const buildZip = (files: readonly ZipFile[]): Uint8Array => {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04_03_4b_50, true);
    lv.setUint16(6, file.flags ?? 0, true);
    lv.setUint16(8, file.method ?? 0, true);
    lv.setUint32(18, file.data.length, true);
    lv.setUint32(22, file.size ?? file.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02_01_4b_50, true);
    cv.setUint16(8, file.flags ?? 0, true);
    cv.setUint16(10, file.method ?? 0, true);
    cv.setUint32(20, file.data.length, true);
    cv.setUint32(24, file.size ?? file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);
    parts.push(local, file.data);
    central.push(header);
    offset += local.length + file.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06_05_4b_50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => new Error("expected a failure"),
    (error: unknown) => error
  );

const member = (fields: Record<string, string>) =>
  `<Member>${Object.entries(fields)
    .map(([tag, value]) =>
      value === "" ? `<${tag} />` : `<${tag}>${value}</${tag}>`
    )
    .join("")}</Member>`;

const memberFields = {
  DocID: "20000001",
  FilingDate: "10/1/2026",
  FilingType: "P",
  First: "Jane",
  Last: "Doe",
  Prefix: "Hon.",
  StateDst: "ZZ01",
  Suffix: "",
  Year: "2026",
};

const index = (...members: string[]) =>
  `<?xml version="1.0"?>\n<FinancialDisclosure>${members.join("")}</FinancialDisclosure>`;

describe("House Clerk URLs", () => {
  it("build the index and PTR PDF links", () => {
    expect(houseIndexUrl(2026)).toBe(
      "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip"
    );
    return expect(ptrPdfUrl(2026, "20035143")).toBe(
      "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035143.pdf"
    );
  });
});

describe("index ZIP reader", () => {
  it("inflates the upstream 2026FD.zip fixture and strips the BOM", async () => {
    const xml = await indexXmlFromBytes(FIXTURE, MAX);
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    return expect(xml).toContain("<FinancialDisclosure>");
  });

  it("reads stored entries, skips non-XML entries and accepts bare XML", async () => {
    const xml = index(member(memberFields));
    const zip = buildZip([
      { data: encoder.encode("hi"), name: "readme.txt" },
      { data: encoder.encode(xml), name: "2026FD.XML" },
    ]);
    expect(new TextDecoder().decode(await readZipXml(zip, MAX))).toBe(xml);
    expect(await indexXmlFromBytes(encoder.encode(xml), MAX)).toBe(xml);
    return expect(await indexXmlFromBytes(encoder.encode(`P${xml}`), MAX)).toBe(
      `P${xml}`
    );
  });

  it("rejects damaged, unsupported and oversized archives", async () => {
    const xml = encoder.encode(index());
    const good = buildZip([{ data: xml, name: "a.xml" }]);
    const cases: [Uint8Array, string][] = [
      [good.slice(0, 10), "ZIP is truncated"],
      [new Uint8Array(40).fill(0x50), "ZIP has no end of directory"],
      [buildZip([{ data: xml, name: "a.txt" }]), "ZIP holds no XML"],
      [
        buildZip([{ data: xml, flags: 1, name: "a.xml" }]),
        "ZIP entry is encrypted",
      ],
      [
        buildZip([{ data: xml, name: "a.xml", size: xml.length - 1 }]),
        "ZIP stored entry sizes disagree",
      ],
      [
        buildZip([{ data: xml, name: "a.xml", size: MAX + 1 }]),
        "index XML exceeds the size cap",
      ],
      [
        buildZip([{ data: xml, method: 12, name: "a.xml" }]),
        "ZIP compression method is not supported",
      ],
      [
        buildZip([
          {
            data: new Uint8Array([0xff, 0xff, 0xff]),
            method: 8,
            name: "a.xml",
          },
        ]),
        "ZIP entry could not be inflated",
      ],
    ];
    for (const [bytes, message] of cases) {
      const error = await fail(readZipXml(bytes, MAX));
      expect(error).toBeInstanceOf(CongressIndexError);
      expect(error).toMatchObject({ message });
    }
    const capped = await fail(
      readZipXml(
        buildZip([
          {
            data: deflateRawSync(new Uint8Array(4096)),
            method: 8,
            name: "a.xml",
          },
        ]),
        100
      )
    );
    expect(capped).toMatchObject({ message: "index XML exceeds the size cap" });

    const badCentral = good.slice();
    const view = new DataView(badCentral.buffer);
    const eocd = badCentral.length - 22;
    const centralAt = view.getUint32(eocd + 16, true);
    view.setUint32(centralAt, 0, true);
    expect(await fail(readZipXml(badCentral, MAX))).toMatchObject({
      message: "ZIP central directory is damaged",
    });
    const pastEnd = good.slice();
    new DataView(pastEnd.buffer).setUint32(eocd + 16, eocd + 10, true);
    expect(await fail(readZipXml(pastEnd, MAX))).toMatchObject({
      message: "ZIP central directory is damaged",
    });

    const badLocal = good.slice();
    new DataView(badLocal.buffer).setUint32(0, 0, true);
    expect(await fail(readZipXml(badLocal, MAX))).toMatchObject({
      message: "ZIP local header is damaged",
    });
    const localPastEnd = good.slice();
    new DataView(localPastEnd.buffer).setUint32(centralAt + 42, eocd, true);
    expect(await fail(readZipXml(localPastEnd, MAX))).toMatchObject({
      message: "ZIP local header is damaged",
    });
    const truncatedName = good.slice();
    new DataView(truncatedName.buffer).setUint16(centralAt + 28, 0xff_ff, true);
    expect(await fail(readZipXml(truncatedName, MAX))).toMatchObject({
      message: "ZIP central directory is damaged",
    });
    const sizePastEnd = good.slice();
    new DataView(sizePastEnd.buffer).setUint32(centralAt + 20, 1_048_576, true);
    return expect(await fail(readZipXml(sizePastEnd, MAX))).toMatchObject({
      message: "ZIP is truncated",
    });
  });

  it("rejects oversized or non-UTF-8 bare XML", async () => {
    expect(
      await fail(indexXmlFromBytes(encoder.encode("<x/>"), 2))
    ).toMatchObject({ message: "index XML exceeds the size cap" });
    return expect(
      await fail(indexXmlFromBytes(new Uint8Array([0x3c, 0xff, 0x3e]), MAX))
    ).toMatchObject({ message: "index XML is not valid UTF-8" });
  });
});

describe("index XML parser", () => {
  it("reads every member of the fixture with names, districts, dates and PDF links", async () => {
    const filings = parseFilingIndex(await indexXmlFromBytes(FIXTURE, MAX));
    expect(filings).toHaveLength(16);
    expect(filings.filter((row) => row.filingType === "P")).toHaveLength(13);
    const pelosi = filings.filter((row) => row.lastName === "Pelosi");
    expect(pelosi.map((row) => row.filedOn)).toEqual([
      "2026-01-23",
      "2026-06-23",
      "2026-08-21",
      "2026-10-02",
    ]);
    expect(pelosi[2]).toEqual({
      docId: "20035143",
      filedOn: "2026-08-21",
      filingType: "P",
      firstName: "Nancy",
      lastName: "Pelosi",
      member: "Nancy Pelosi",
      pdfUrl:
        "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035143.pdf",
      stateDistrict: "CA11",
      year: 2026,
    });
    return expect(
      filings.find((row) => row.lastName === "Salazar")?.member
    ).toBe("Maria Elvira Salazar");
  });

  it("decodes entities, keeps suffixes and skips malformed members", () => {
    const filings = parseFilingIndex(
      index(
        member({
          ...memberFields,
          First: "J&#233;r&#xF4;me",
          Last: "O&apos;Brien &amp; Sons",
          Suffix: "Jr.",
        }),
        member({ ...memberFields, DocID: "../evil" }),
        member({ ...memberFields, Last: "" }),
        member({ ...memberFields, FilingDate: "13/45/2026" }),
        member({ ...memberFields, Year: "1999" }),
        "<Member><Last>Unclosed</Last>"
      )
    );
    expect(filings).toHaveLength(1);
    return expect(filings[0]).toMatchObject({
      firstName: "Jérôme",
      lastName: "O'Brien & Sons",
      member: "Jérôme O'Brien & Sons Jr.",
      stateDistrict: "ZZ01",
    });
  });

  it("rejects a document that is not a disclosure index", () => {
    expect(() => parseFilingIndex("<html>nope</html>")).toThrow(
      CongressIndexError
    );
    return expect(parseFilingIndex(index())).toEqual([]);
  });

  it("decodes only well-formed character references", () => {
    expect(decodeXmlText("&lt;a&gt; &quot;b&quot; &#65;&#x42;")).toBe(
      '<a> "b" AB'
    );
    return expect(decodeXmlText("&nbsp; &#0; &#x110000; &AMP; & x")).toBe(
      "&nbsp; &#0; &#x110000; &AMP; & x"
    );
  });

  it("parses Clerk M/D/YYYY dates strictly", () => {
    expect(isoFromMdy("8/21/2026")).toBe("2026-08-21");
    expect(isoFromMdy(" 08/01/2026 ")).toBe("2026-08-01");
    expect(isoFromMdy("6/17/27")).toBe("2027-06-17");
    expect(isoFromMdy("13/45/2026")).toBeNull();
    expect(isoFromMdy("2/30/2026")).toBeNull();
    expect(isoFromMdy("1/1/0050")).toBeNull();
    expect(isoFromMdy("2026-08-21")).toBeNull();
    return expect(isoFromMdy("")).toBeNull();
  });
});

describe("window selection", () => {
  it("covers the last N days and adds the previous year across Jan 1", () => {
    const october = filingWindow(new Date("2026-10-13T15:00:00Z"), 7);
    expect(october).toEqual({ since: "2026-10-06", until: "2026-10-13" });
    expect(windowYears(october)).toEqual([2026]);
    const january = filingWindow(new Date("2026-01-10T01:00:00Z"), 30);
    expect(january).toEqual({ since: "2025-12-11", until: "2026-01-10" });
    return expect(windowYears(january)).toEqual([2026, 2025]);
  });

  it("keeps PTRs in the window, newest first, deduplicated, with sorted members", async () => {
    const filings = parseFilingIndex(await indexXmlFromBytes(FIXTURE, MAX));
    const window = { since: "2026-10-02", until: "2026-10-12" };
    const extra: IndexFiling = {
      ...(filings.find((row) => row.docId === "20035553") as IndexFiling),
    };
    const selected = selectPtrFilings([...filings, extra], window);
    expect(selected.map((row) => [row.filedOn, row.docId])).toEqual([
      ["2026-10-12", "20035635"],
      ["2026-10-12", "20035622"],
      ["2026-10-12", "20035585"],
      ["2026-10-07", "20035590"],
      ["2026-10-07", "20035562"],
      ["2026-10-05", "20035580"],
      ["2026-10-02", "20035558"],
      ["2026-10-02", "20035553"],
    ]);
    expect(selected[0]).not.toHaveProperty("filingType");
    expect(
      selectPtrFilings(filings, { since: "2026-10-13", until: "2026-12-31" })
    ).toEqual([]);
    expect(
      selectPtrFilings(filings, { since: "2026-01-01", until: "2026-01-31" })
    ).toHaveLength(1);
    expect(distinctMembers(selected)).toEqual([
      "Gilbert Cisneros",
      "Lloyd Doggett",
      "Josh Gottheimer",
      "Rick Larsen",
      "Lisa McClain",
      "Nancy Pelosi",
      "Michael Rulli",
      "Maria Elvira Salazar",
    ]);
    const twins = [
      { ...selected[0], lastName: "Smith", member: "Zed Smith" },
      { ...selected[1], lastName: "Smith", member: "Amy Smith" },
    ] as typeof selected;
    return expect(distinctMembers(twins)).toEqual(["Amy Smith", "Zed Smith"]);
  });
});
