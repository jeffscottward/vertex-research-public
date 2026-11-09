// Synthetic stand-ins for the QuantFinanceToGo knowledge-base sources, for tests, CI and the E2E seed.
// One row per reel with its public id, URL, date and length, and placeholder caption and transcript
// text. Owner decision (2026-11-08): the real captions and transcripts stay out of this repository;
// `bun run vertex:academy:import` reads them from the knowledge base (scripts/academy/build-sources.ts
// parses the notes). A new reel needs a row here as well as its note in the knowledge base.
// scripts/academy/private-sources.test.ts keeps this file synthetic.

/** Placeholder text of every fixture source; nothing here comes from a real caption or transcript. */
export const FIXTURE_TEXT =
  "Synthetic fixture text (the real text is in the knowledge base).";

const reel = (
  sourceId: string,
  publishedAt: string,
  durationSeconds: number
) => ({
  caption: FIXTURE_TEXT,
  course: "quantfinancetogo",
  durationSeconds,
  publishedAt,
  sourceId,
  transcript: [{ start: 0, text: FIXTURE_TEXT }],
  url: `https://www.instagram.com/reel/${sourceId}/`,
});

export const SOURCES: readonly unknown[] = [
  reel("Dc-5trhCw-I", "2026-09-07", 29.68),
  reel("Dc7IyDbiITE", "2026-09-05", 27.03),
  reel("Dc8aNqHKV02", "2026-09-06", 29.02),
  reel("Dc9OSjTRNlf", "2026-09-06", 26.96),
  reel("Dcy9ZOaRWLc", "2026-09-02", 24.03),
  reel("Dd148jPRka7", "2026-09-28", 87.43),
  reel("Dd1PeNiCtkl", "2026-09-28", 144.3),
  reel("Dd31O8FCqsi", "2026-09-29", 95.85),
  reel("Dd4puohxGZj", "2026-09-29", 83.64),
  reel("Dd6N64VCrUl", "2026-09-30", 92.14),
  reel("Dd8m63oq2-c", "2026-10-01", 96.32),
  reel("DdBcZYUKs6o", "2026-09-08", 27.28),
  reel("DdRP_zWCn6b", "2026-09-14", 70.7),
  reel("Dd_T9C6CP7I", "2026-10-02", 95.34),
  reel("Ddqpd2CCPjW", "2026-09-24", 127.32),
  reel("DdtZ1ILiKRv", "2026-09-25", 126.74),
  reel("Ddw733pRWc1", "2026-09-26", 162.31),
  reel("Ddyk2PkqdRy", "2026-09-27", 140.3),
  reel("De4D23VCl2E", "2026-10-24", 117.98),
  reel("De6k6pexwag", "2026-10-25", 81.69),
  reel("De9QTG2iGeJ", "2026-10-26", 94.88),
  reel("DeCw2yPRF6M", "2026-10-03", 118.281_997_680_664_06),
  reel("DeD3ruoCXGg", "2026-10-04", 101.66),
  reel("DeFCbkaiVMa", "2026-10-04", 117.93),
  reel("DeG3qGCirGO", "2026-10-05", 94.62),
  reel("DeMicsbCEBe", "2026-10-07", 99.938_003_540_039_06),
  reel("DeO84H5Cho0", "2026-10-08", 99.52),
  reel("DeSWK28Re6i", "2026-10-09", 91.14),
  reel("DeUlwIYikQz", "2026-10-10", 112.78),
  reel("DeWlPe2id2c", "2026-10-11", 97.57),
  reel("DeY9P8_CpfW", "2026-10-12", 105),
  reel("Debex7eiZZu", "2026-10-13", 157.08),
  reel("DedydiLiCtv", "2026-10-14", 142.62),
  reel("DegqV3-CtXZ", "2026-10-15", 133.12),
  reel("DejMi0yRAm3", "2026-10-16", 105.28),
  reel("DemrBpwCemC", "2026-10-17", 98.15),
  reel("Deo-i-zCdMb", "2026-10-18", 104),
  reel("DerWwTTiKGS", "2026-10-19", 106.21),
  reel("Dewi5Z1CDEU", "2026-10-21", 141.64),
  reel("Dey6117Chzb", "2026-10-22", 150.81),
  reel("DfCQKtXCuR8", "2026-10-28", 109.39),
  reel("DfF_G7CRae2", "2026-10-29", 155.97),
  reel("DfIZiJGRrGI", "2026-10-30", 113.78),
  reel("DfK1oP4IkLF", "2026-10-31", 118),
  reel("DfNAhn7iHRa", "2026-11-01", 97.62),
  reel("DfPHPULRYE7", "2026-11-02", 100.47),
  reel("DfRnjfGRKH-", "2026-11-03", 96.71),
  reel("DfU7H28RDtA", "2026-11-04", 88.31),
  reel("DfZSXlgxRCt", "2026-11-06", 113.01),
  reel("DfchQKCRSx7", "2026-11-07", 104.35),
  reel("Dfeu_BMxSc6", "2026-11-08", 146.05),
];
