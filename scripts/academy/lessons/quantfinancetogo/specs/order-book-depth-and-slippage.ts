// Lesson spec: The order book: bid, ask, spread, depth and the slippage of a market order
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "A static book with sizes that grow by a fixed share per level; real books change every moment as orders arrive, cancel and react.",
    "No fees, hidden orders or fast traders reacting to each other, as the creator also notes.",
    "The reel's numbers (3.19-cent average spread, an 8-cent move, a fill 4.10 cents above the old best ask) come from the creator's random simulation of one stock and are not verified; this book is set up to reproduce the 20,000-share example.",
    "Real spreads and depth depend on the stock, the exchange and the time of day.",
  ],
  course: "quantfinancetogo",
  formulas: ["slippage"],
  kind: "concept",
  params: [
    {
      default: 20_000,
      help: "Shares in the market buy order.",
      id: "orderSize",
      label: "Market buy size",
      max: 40_000,
      min: 0,
      step: 500,
      unit: "shares",
    },
    {
      default: 1690,
      help: "Shares waiting at the best bid and at the best ask.",
      id: "levelSize",
      label: "Size at the best price",
      max: 20_000,
      min: 100,
      step: 10,
      unit: "shares",
    },
    {
      default: 12,
      help: "Price levels shown on each side of the book.",
      id: "levels",
      label: "Levels per side",
      max: 40,
      min: 1,
      step: 1,
    },
    {
      default: 0.01,
      help: "Smallest price step.",
      id: "tickSize",
      label: "Tick size",
      max: 1,
      min: 0.01,
      step: 0.01,
      unit: "$",
    },
    {
      default: 3,
      help: "Gap between the best bid and the best ask, in ticks.",
      id: "spreadTicks",
      label: "Spread",
      max: 50,
      min: 1,
      step: 1,
    },
    {
      default: 10.3,
      help: "How much more size waits at each level further from the best price; higher means a deeper book.",
      id: "depthGrowth",
      label: "Depth growth per level",
      max: 100,
      min: -20,
      step: 0.1,
      unit: "%",
    },
    {
      default: 97.615,
      help: "Midpoint between the best bid and the best ask.",
      id: "mid",
      label: "Mid price",
      max: 1000,
      min: 1,
      step: 0.005,
      unit: "$",
    },
  ],
  scene: {
    mode: "orderbook",
    type: "quant",
  },
  slug: "order-book-depth-and-slippage",
  sourceId: "DfIZiJGRrGI",
  steps: [
    {
      caption:
        "The order book: the list of all waiting orders for one stock, by price.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Buyers on one side with the prices they will pay. The highest is the best bid.",
      color: "green",
      element: "bids",
    },
    {
      caption:
        "Sellers on the other with the prices they want. The lowest is the best ask, and the gap between them is the spread.",
      color: "red",
      element: "asks",
    },
    {
      caption:
        "A market buy for 20,000 shares does not wait. It is larger than what waits at the best price, so it eats through the next levels.",
      color: "amber",
      element: "sweep",
      time: [0, 1],
    },
    {
      caption:
        "Every level costs a little more: the average fill ends 4.10 cents above the old best ask, and the best ask moves from $97.63 to $97.71.",
      color: "gold",
      element: "avg",
    },
    {
      caption:
        "Slippage grows with order size. Depth decides how much: a deep book absorbs large orders, a thin book lets the price jump.",
      color: "red",
      element: "curve",
    },
    {
      caption: "The 20,000-share order on that curve.",
      color: "blue",
      element: "marker",
    },
  ],
  summary:
    "How the order book works. Waiting limit orders form the bids and the asks; the best bid and best ask are the best prices and the gap between them is the spread. A market order trades at once against the other side; if it is larger than the size at the best price it eats through the next levels, pays more at each (slippage) and pushes the price.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "intraday",
    topics: [
      "order book",
      "bid-ask spread",
      "slippage",
      "market depth",
      "market making",
      "limit orders",
    ],
  },
  takeaways: [
    "Limit orders wait in the book: buy or sell, but only at this price or better. The best bid and best ask are the best prices; the gap is the spread.",
    "A market order trades right away against the best orders on the other side.",
    "If it is larger than the size at the best price, it eats through the next levels; every level costs a little more (slippage) and a large buy pushes the price up.",
    "Market makers keep orders on both sides and earn the spread; depth decides how much a large order moves the price.",
  ],
  title:
    "The order book: bid, ask, spread, depth and the slippage of a market order",
} satisfies LessonSpecInput;
