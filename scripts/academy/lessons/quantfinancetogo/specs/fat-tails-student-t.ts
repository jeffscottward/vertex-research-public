import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "The Student t curve is an assumption too: every model of the tails is a guess about rare days.",
    "Simulated returns with assumed numbers (1% a day, 3 degrees of freedom), not market data; counts change with the seed.",
    "The Black Monday odds in the reel (about once in 216 years with fat tails) are model numbers, not forecasts.",
  ],
  course: "quantfinancetogo",
  formulas: ["studentT"],
  kind: "concept",
  params: [
    {
      default: 1,
      help: "Typical one-day swing; both curves get this same volatility.",
      id: "dailyVol",
      label: "Daily volatility",
      max: 5,
      min: 0.2,
      step: 0.1,
      unit: "%",
    },
    {
      default: 3,
      help: "Lower = fatter tails. The reel uses 3.",
      id: "dof",
      label: "Degrees of freedom (t)",
      max: 30,
      min: 2.5,
      step: 0.5,
    },
    {
      default: 99,
      id: "confidence",
      label: "Confidence level",
      max: 99.9,
      min: 90,
      step: 0.1,
      unit: "%",
    },
    {
      default: 25_200,
      help: "25,200 trading days = 100 years.",
      id: "days",
      label: "Simulated days",
      max: 25_200,
      min: 252,
      step: 252,
      unit: "days",
    },
    {
      default: 100_000,
      id: "position",
      label: "Position size",
      max: 10_000_000,
      min: 1000,
      step: 1000,
      unit: "$",
    },
    {
      default: 8,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "tail",
    type: "quant",
  },
  slug: "fat-tails-student-t",
  sourceId: "DeSWK28Re6i",
  steps: [
    {
      caption:
        "100 simulated years of daily returns at about 1% a day, drawn from a fat-tailed curve",
      color: "gray",
      element: "axes",
    },
    {
      caption: "The simulated days pile up: most days stay close to zero",
      color: "cyan",
      element: "bars",
      seconds: 6,
      time: [0, 1],
    },
    {
      caption:
        "Bell curve with the same 1% daily swing: most days near the middle, big moves extremely rare",
      color: "blue",
      element: "normal",
    },
    {
      caption:
        "Student t with 3 degrees of freedom: taller in the middle and heavier at the edges, same volatility",
      color: "red",
      element: "fat",
    },
    {
      caption:
        "Shaded: the worst 1% of days. On the log scale below, the bell curve's tails vanish; the table counts days beyond 5%",
      color: "violet",
      element: "tail",
    },
  ],
  summary:
    "Large price moves happen far more often in real markets than a bell curve allows. With equal volatility, a fat-tailed curve has a higher peak and thicker edges. The creator runs 100 years of simulated days at about 1% a day under both models, a bell curve and a Student t curve with 3 degrees of freedom: no days beyond 5% for the bell, 74 for the Student t.",
  tags: {
    instruments: ["portfolio", "volatility"],
    regime: ["any"],
    risk: "none",
    timeframe: "days",
    topics: ["fat tails", "student t", "tail risk", "black monday"],
  },
  takeaways: [
    "Large moves show up in real price changes far more often than a bell curve allows.",
    "With equal volatility, a fat-tailed curve has a higher peak and thicker edges than the bell.",
    "In the creator's 100-year simulation at 1% a day: 0 days beyond 5% on the bell curve, 74 with fat tails (Student t, 3 degrees of freedom).",
    "Under a bell-curve risk model, crashes look nearly impossible; a fat-tailed model makes Black Monday (-22.6%) rare but expected.",
  ],
  title: "Fat tails: big daily moves the bell curve calls impossible",
} satisfies LessonSpecInput;
