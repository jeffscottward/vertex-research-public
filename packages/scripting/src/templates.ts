// Starter indicator library. Every template is ordinary Vertex script source written for this
// subset (not copied from TradingView); tests compile and run each one on fixture bars.

import type { ScriptTemplate } from "./types.ts";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

export const SCRIPT_TEMPLATES: readonly ScriptTemplate[] = [
  {
    category: "trend",
    description:
      "Fast and slow simple moving averages with markers where they cross.",
    id: "sma-cross",
    source: lines(
      "//@version=5",
      'indicator("SMA Cross", shorttitle="SMA X", overlay=true)',
      'fastLen = input.int(10, "Fast length", minval=1)',
      'slowLen = input.int(30, "Slow length", minval=2)',
      "fast = ta.sma(close, fastLen)",
      "slow = ta.sma(close, slowLen)",
      'plot(fast, "Fast SMA", color=color.orange)',
      'plot(slow, "Slow SMA", color=color.blue)',
      'plotshape(ta.crossover(fast, slow), "Golden cross", location=location.belowbar, text="X+", color=color.green)',
      'plotshape(ta.crossunder(fast, slow), "Death cross", location=location.abovebar, text="X-", color=color.red)'
    ),
    title: "SMA Cross",
  },
  {
    category: "trend",
    description:
      "Five exponential moving averages; the ribbon fans out in strong trends.",
    id: "ema-ribbon",
    source: lines(
      "//@version=5",
      'indicator("EMA Ribbon", shorttitle="Ribbon", overlay=true)',
      'base = input.int(8, "Shortest length", minval=1)',
      'src = input.source(close, "Source")',
      "// Fibonacci-spaced lengths from the shortest one.",
      "ribbon(n) =>",
      "    ta.ema(src, n)",
      'plot(ribbon(base), "EMA 1", color=color.yellow)',
      'plot(ribbon(base + 5), "EMA 2", color=color.orange)',
      'plot(ribbon(base + 13), "EMA 3", color=color.red)',
      'plot(ribbon(base + 26), "EMA 4", color=color.purple)',
      'plot(ribbon(base + 47), "EMA 5", color=color.navy)'
    ),
    title: "EMA Ribbon",
  },
  {
    category: "momentum",
    description: "Wilder RSI with overbought 70 and oversold 30 levels.",
    id: "rsi",
    source: lines(
      "//@version=5",
      'indicator("Relative Strength Index", shorttitle="RSI")',
      'src = input.source(close, "Source")',
      'len = input.int(14, "Length", minval=1)',
      'upper = input.int(70, "Overbought", minval=50, maxval=100)',
      'lower = input.int(30, "Oversold", minval=0, maxval=50)',
      "r = ta.rsi(src, len)",
      'plot(r, "RSI", color=color.purple)',
      'hline(upper, "Overbought", color=color.red)',
      'hline(50, "Middle", color=color.gray)',
      'hline(lower, "Oversold", color=color.green)'
    ),
    title: "RSI (70/30)",
  },
  {
    category: "momentum",
    description: "MACD line, signal line and histogram from two EMAs.",
    id: "macd",
    source: lines(
      "//@version=5",
      'indicator("MACD", shorttitle="MACD")',
      'fastLen = input.int(12, "Fast length", minval=1)',
      'slowLen = input.int(26, "Slow length", minval=1)',
      'sigLen = input.int(9, "Signal length", minval=1)',
      "[macdLine, signalLine, hist] = ta.macd(close, fastLen, slowLen, sigLen)",
      'plot(hist, "Histogram", color=hist >= 0 ? color.teal : color.red, style=plot.style_histogram)',
      'plot(macdLine, "MACD", color=color.blue)',
      'plot(signalLine, "Signal", color=color.orange)',
      'hline(0, "Zero", color=color.gray)'
    ),
    title: "MACD",
  },
  {
    category: "volatility",
    description: "SMA basis with bands two standard deviations away.",
    id: "bollinger-bands",
    source: lines(
      "//@version=5",
      'indicator("Bollinger Bands", shorttitle="BB", overlay=true)',
      'len = input.int(20, "Length", minval=1)',
      'mult = input.float(2.0, "Std dev multiplier", minval=0.1, maxval=5)',
      'src = input.source(close, "Source")',
      "[basis, upper, lower] = ta.bb(src, len, mult)",
      'plot(basis, "Basis", color=color.orange)',
      'plot(upper, "Upper", color=color.blue)',
      'plot(lower, "Lower", color=color.blue)'
    ),
    title: "Bollinger Bands",
  },
  {
    category: "volatility",
    description: "EMA basis with bands a multiple of Wilder ATR away.",
    id: "keltner-channel",
    source: lines(
      "//@version=5",
      'indicator("Keltner Channel", shorttitle="KC", overlay=true)',
      'len = input.int(20, "EMA length", minval=1)',
      'atrLen = input.int(10, "ATR length", minval=1)',
      'mult = input.float(2.0, "ATR multiplier", minval=0.1)',
      "basis = ta.ema(close, len)",
      "band = ta.atr(atrLen) * mult",
      'plot(basis, "Basis", color=color.teal)',
      'plot(basis + band, "Upper", color=color.red)',
      'plot(basis - band, "Lower", color=color.green)'
    ),
    title: "Keltner Channel (ATR bands)",
  },
  {
    category: "volatility",
    description:
      "Highest high and lowest low over a lookback, with the midline.",
    id: "donchian-channel",
    source: lines(
      "//@version=5",
      'indicator("Donchian Channel", shorttitle="DC", overlay=true)',
      'len = input.int(20, "Length", minval=1)',
      "upper = ta.highest(high, len)",
      "lower = ta.lowest(low, len)",
      "mid = math.avg(upper, lower)",
      'plot(upper, "Upper", color=color.blue)',
      'plot(mid, "Basis", color=color.orange)',
      'plot(lower, "Lower", color=color.blue)'
    ),
    title: "Donchian Channel",
  },
  {
    category: "momentum",
    description: "Smoothed %K and %D stochastic oscillator with 80/20 levels.",
    id: "stochastic",
    source: lines(
      "//@version=5",
      'indicator("Stochastic", shorttitle="Stoch")',
      'periodK = input.int(14, "%K length", minval=1)',
      'smoothK = input.int(3, "%K smoothing", minval=1)',
      'periodD = input.int(3, "%D smoothing", minval=1)',
      "k = ta.sma(ta.stoch(close, high, low, periodK), smoothK)",
      "d = ta.sma(k, periodD)",
      'plot(k, "%K", color=color.blue)',
      'plot(d, "%D", color=color.orange)',
      'hline(80, "Upper", color=color.gray)',
      'hline(20, "Lower", color=color.gray)'
    ),
    title: "Stochastic",
  },
  {
    category: "momentum",
    description: "CCI of the typical price with +100/-100 levels.",
    id: "cci",
    source: lines(
      "//@version=5",
      'indicator("Commodity Channel Index", shorttitle="CCI")',
      'len = input.int(20, "Length", minval=1)',
      "c = ta.cci(hlc3, len)",
      'plot(c, "CCI", color=color.teal)',
      'hline(100, "Upper", color=color.gray)',
      'hline(-100, "Lower", color=color.gray)'
    ),
    title: "Commodity Channel Index",
  },
  {
    category: "volume",
    description: "Cumulative signed volume with an EMA signal line.",
    id: "obv",
    source: lines(
      "//@version=5",
      'indicator("On-Balance Volume", shorttitle="OBV")',
      'len = input.int(20, "Signal length", minval=1)',
      "obv = ta.obv",
      'plot(obv, "OBV", color=color.blue)',
      'plot(ta.ema(obv, len), "Signal", color=color.orange)'
    ),
    title: "On-Balance Volume",
  },
  {
    category: "volume",
    description:
      "Volume-weighted vs simple average; VWMA above SMA means volume backs up-moves.",
    id: "vwma-vs-sma",
    source: lines(
      "//@version=5",
      'indicator("VWMA vs SMA", shorttitle="VWMA/SMA", overlay=true)',
      'len = input.int(20, "Length", minval=1)',
      "v = ta.vwma(close, len)",
      "s = ta.sma(close, len)",
      'plot(v, "VWMA", color=color.purple, linewidth=2)',
      'plot(s, "SMA", color=color.gray)',
      'plotshape(ta.crossover(v, s), "Volume-led up", location=location.belowbar, text="V+", color=color.green)',
      'plotshape(ta.crossunder(v, s), "Volume-led down", location=location.abovebar, text="V-", color=color.red)'
    ),
    title: "VWMA vs SMA",
  },
  {
    category: "trend",
    description:
      "Ratcheting ATR stop that flips direction when price closes through it.",
    id: "atr-trailing-stop",
    source: lines(
      "//@version=5",
      'indicator("ATR Trailing Stop", shorttitle="ATR Stop", overlay=true)',
      'atrLen = input.int(10, "ATR length", minval=1)',
      'mult = input.float(3.0, "ATR multiplier", minval=0.1)',
      "atr = ta.atr(atrLen)",
      "up = hl2 - mult * atr",
      "dn = hl2 + mult * atr",
      "var float longStop = na",
      "var float shortStop = na",
      "var int dir = 1",
      "// Ratchet: a long stop only rises and a short stop only falls while price respects it.",
      "longStop := na(longStop) or close[1] < longStop ? up : math.max(up, longStop)",
      "shortStop := na(shortStop) or close[1] > shortStop ? dn : math.min(dn, shortStop)",
      "if dir == -1 and close > shortStop[1]",
      "    dir := 1",
      "else if dir == 1 and close < longStop[1]",
      "    dir := -1",
      'plot(dir == 1 ? longStop : na, "Long stop", color=color.green, linewidth=2)',
      'plot(dir == -1 ? shortStop : na, "Short stop", color=color.red, linewidth=2)',
      'plotshape(dir == 1 and dir[1] == -1, "Flip up", location=location.belowbar, text="Up", color=color.green)',
      'plotshape(dir == -1 and dir[1] == 1, "Flip down", location=location.abovebar, text="Down", color=color.red)'
    ),
    title: "ATR Trailing Stop (Supertrend-like)",
  },
  {
    category: "trend",
    description:
      "Confirmed swing pivots and the latest pivot high/low as resting liquidity levels.",
    id: "pivot-levels",
    source: lines(
      "//@version=5",
      'indicator("Pivot Liquidity Levels", shorttitle="Pivots", overlay=true)',
      'left = input.int(5, "Left bars", minval=1)',
      'right = input.int(5, "Right bars", minval=1)',
      "ph = ta.pivothigh(high, left, right)",
      "pl = ta.pivotlow(low, left, right)",
      "// Hold the most recent confirmed pivot as a level until a new one forms.",
      "lastHigh = ta.valuewhen(not na(ph), ph, 0)",
      "lastLow = ta.valuewhen(not na(pl), pl, 0)",
      'plot(lastHigh, "Buy-side liquidity", color=color.red, style=plot.style_circles)',
      'plot(lastLow, "Sell-side liquidity", color=color.green, style=plot.style_circles)',
      'plotshape(not na(ph), "Pivot high", location=location.abovebar, offset=-right, text="PH", color=color.red)',
      'plotshape(not na(pl), "Pivot low", location=location.belowbar, offset=-right, text="PL", color=color.green)'
    ),
    title: "Pivot Highs/Lows (liquidity levels)",
  },
  {
    category: "strategy",
    description:
      "Long on a fast/slow SMA golden cross, short on a death cross. Markers only.",
    id: "strategy-ma-cross",
    source: lines(
      "//@version=5",
      'strategy("MA Cross Strategy", shorttitle="MA Cross", overlay=true)',
      'fastLen = input.int(10, "Fast length", minval=1)',
      'slowLen = input.int(30, "Slow length", minval=2)',
      "fast = ta.sma(close, fastLen)",
      "slow = ta.sma(close, slowLen)",
      'plot(fast, "Fast", color=color.orange)',
      'plot(slow, "Slow", color=color.blue)',
      "if ta.crossover(fast, slow)",
      '    strategy.entry("Long", strategy.long)',
      "if ta.crossunder(fast, slow)",
      '    strategy.entry("Short", strategy.short)'
    ),
    title: "Strategy: MA Cross",
  },
  {
    category: "strategy",
    description:
      "Buy when RSI climbs back above oversold; exit when it falls back below overbought.",
    id: "strategy-rsi-mean-reversion",
    source: lines(
      "//@version=5",
      'strategy("RSI Mean Reversion", shorttitle="RSI MR")',
      'len = input.int(14, "RSI length", minval=2)',
      'oversold = input.float(30, "Oversold", minval=1, maxval=50)',
      'overbought = input.float(70, "Overbought", minval=50, maxval=99)',
      "r = ta.rsi(close, len)",
      'plot(r, "RSI", color=color.purple)',
      'hline(overbought, "Overbought", color=color.red)',
      'hline(oversold, "Oversold", color=color.green)',
      "if ta.crossover(r, oversold)",
      '    strategy.entry("Long", strategy.long, comment="RSI long")',
      "if ta.crossunder(r, overbought)",
      '    strategy.close("Long", comment="RSI exit")'
    ),
    title: "Strategy: RSI Mean Reversion",
  },
];

export const scriptTemplate = (id: string): ScriptTemplate | undefined =>
  SCRIPT_TEMPLATES.find((template) => template.id === id);
