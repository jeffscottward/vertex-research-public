// Test double for the Nautilus batch process of dsl-engine.ts: an in-memory file system and a
// "python" that answers each case with the TypeScript engine, times `scale` (1 = equal engines).
import { runStrategyDefinition } from "../../packages/api/src/strategy-dsl-compile.ts";
import { NAUTILUS_ENGINE_ID, type NautilusIo } from "./dsl-engine.ts";

type BatchFile = Readonly<{
  bars: Readonly<
    Record<"t" | "o" | "h" | "l" | "c", number[]> & { v?: number[] }
  >;
  cases: readonly Readonly<{
    id: string;
    spec: Readonly<{
      costBps: number;
      rule: Readonly<{ kind: string; definition: never }>;
    }>;
  }>[];
}>;

export type FakeNautilus = Omit<NautilusIo, "python" | "root"> &
  Readonly<{
    calls: { python: string; args: readonly string[]; cwd: string }[];
  }>;

export const fakeNautilus = (
  options: Readonly<{ scale?: number; status?: number; engine?: string }> = {}
): FakeNautilus => {
  const files = new Map<string, string>();
  const calls: FakeNautilus["calls"] = [];
  let dirs = 0;
  return {
    calls,
    readText: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    spawn: (python, args, cwd) => {
      calls.push({ args, cwd, python });
      if (options.status !== undefined)
        return { status: options.status, stderr: "boom" };
      const [input, output] = args.slice(-2) as [string, string];
      const batch = JSON.parse(files.get(input) as string) as BatchFile;
      const column = (values: readonly number[]) => Float64Array.from(values);
      const bars = {
        c: column(batch.bars.c),
        h: column(batch.bars.h),
        l: column(batch.bars.l),
        o: column(batch.bars.o),
        t: column(batch.bars.t),
        ...(batch.bars.v === undefined ? {} : { v: column(batch.bars.v) }),
      };
      const scale = options.scale ?? 1;
      const results = batch.cases.map((entry) => ({
        id: entry.id,
        result: {
          equity: Array.from(
            runStrategyDefinition(
              bars,
              entry.spec.rule.definition,
              entry.spec.costBps
            ).equity,
            (value, index) => (index === 0 ? value : value * scale)
          ),
          stats: {},
          trades: [],
        },
      }));
      files.set(
        output,
        JSON.stringify({
          engine: options.engine ?? NAUTILUS_ENGINE_ID,
          results,
        })
      );
      return { status: 0, stderr: "" };
    },
    tempDir: () => {
      dirs += 1;
      return `/fake/nautilus-${dirs}`;
    },
    writeText: (path, text) => {
      files.set(path, text);
    },
  };
};
