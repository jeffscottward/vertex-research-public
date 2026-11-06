// Per-bar history buffers. A Series gets one entry per bar on which its owner executed
// (Pine's local-series rule: code in a branch that did not run does not advance); writing
// twice on one bar replaces that bar's entry, so re-evaluation within a bar is idempotent.

import type { Value } from "./values.ts";

export class Series {
  private readonly values: Value[] = [];
  private lastBar = -1;
  // `var` declarations: set once the initializer has run.
  initialized = false;

  set(bar: number, value: Value): void {
    if (bar === this.lastBar && this.values.length > 0) {
      this.values[this.values.length - 1] = value;
      return;
    }
    this.values.push(value);
    this.lastBar = bar;
  }

  // n = 0 is the latest entry; beyond the recorded history is na.
  back(n: number): Value {
    return this.values.at(-(1 + n)) ?? null;
  }

  get length(): number {
    return this.values.length;
  }
}

interface Accumulator {
  bar: number;
  cur: unknown;
  prev: unknown;
}

// State for one stateful builtin call site: named input histories plus recursive
// accumulators (EMA/RMA, cumulative sums) that commit when the bar advances.
export class Site {
  private readonly buffers = new Map<string, Series>();
  private readonly accumulators = new Map<string, Accumulator>();

  series(key: string): Series {
    let series = this.buffers.get(key);
    if (!series) {
      series = new Series();
      this.buffers.set(key, series);
    }
    return series;
  }

  record(key: string, bar: number, value: Value): Series {
    const series = this.series(key);
    series.set(bar, value);
    return series;
  }

  // The accumulator value as of the previous executed bar (initial before the first).
  previous<T>(key: string, bar: number, initial: T): T {
    let acc = this.accumulators.get(key);
    if (!acc) {
      acc = { bar, cur: initial, prev: initial };
      this.accumulators.set(key, acc);
    } else if (acc.bar !== bar) {
      acc.prev = acc.cur;
      acc.bar = bar;
    }
    return acc.prev as T;
  }

  store(key: string, value: unknown): void {
    const acc = this.accumulators.get(key);
    if (acc) acc.cur = value;
  }
}
