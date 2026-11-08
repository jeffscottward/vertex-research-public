// Lesson spec: Present value: why $100 in ten years is worth about $61 today
import type { LessonSpecInput } from "../../../schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The rates are example numbers; real rates change over time and carry risk.",
    "The video's numbers come from the creator's own code and are reproduced here, not independently sourced.",
  ],
  course: "quantfinancetogo",
  formulas: ["presentValue"],
  kind: "concept",
  params: [
    {
      default: 100,
      id: "amount",
      label: "Amount",
      max: 1_000_000,
      min: 1,
      step: 1,
      unit: "$",
    },
    {
      default: 5,
      id: "rate",
      label: "Interest rate per year",
      max: 20,
      min: 0,
      step: 0.5,
      unit: "%",
    },
    {
      default: 10,
      id: "years",
      label: "Years",
      max: 50,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "compound",
    type: "quant",
  },
  slug: "present-value-discounting",
  sourceId: "Dd148jPRka7",
  steps: [
    {
      caption:
        "Dollars over years. One $100 amount, two directions: growing forward and discounting back.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "At 5% the money multiplies by 1.05 each year: $105 after one year, $162.89 after ten.",
      color: "green",
      element: "curve",
      time: [0, 1],
    },
    {
      caption:
        "Run it backwards: $100 due in n years divided by 1.05 n times. Due in ten years it is worth $61.39 today.",
      color: "violet",
      element: "discount",
    },
    {
      caption:
        "The markers move with time: what $100 grows to, and what $100 due then is worth today.",
      color: "amber",
      element: "marker",
      time: [0, 1],
    },
    {
      caption:
        "The rate changes everything: the same $100 in ten years is worth $82.03 at 2% and only $38.55 at 10%.",
      color: "cyan",
      element: "rates",
    },
  ],
  summary:
    "Part 6 of Quant Finance from scratch. At 5% a year, $100 grows to $162.89 in ten years. Run it backwards and $100 due in ten years is worth $61.39 today. The discount rate changes everything: $82.03 at 2%, $38.55 at 10%.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["present value", "compounding", "discounting", "time value"],
  },
  takeaways: [
    "Compounding earns interest on interest: $162.89 after ten years at 5%, not the $150 of plain interest.",
    "Present value divides by (1 + r) once per year: $61.39 today for $100 in ten years at 5%.",
    "A higher discount rate makes future money worth less today.",
  ],
  title: "Present value: why $100 in ten years is worth about $61 today",
};
