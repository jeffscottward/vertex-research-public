// The 30 owner-style questions of docs/vertex-rebuild/agent-semantic-layer.md (Q1-Q20 main set, H1-H5
// held-out set, U1-U5 engine runs with no strategy, answered per run spec) with a fixed grading rubric over the synthetic fixture (fixture.sql + the feed fixtures in
// fixtures.ts). Grades:
// - correct: every `required` pattern matches and no `forbidden` pattern matches;
// - wrong: a `forbidden` pattern matches (a value from the wrong source or a wrong value);
// - declined: anything else (no wrong value, but the required value is missing).
// Paper exec-node values (deployment_status) are forbidden in every answer: an account answer must come
// from the live account, and quoting the paper value next to it invites the error this layer prevents.

export type QuestionKind = "account" | "research" | "not_available";
export type QuestionSet = "main" | "held_out" | "unlinked";

export type EvalQuestion = Readonly<{
  id: string;
  set: QuestionSet;
  kind: QuestionKind;
  question: string;
  reference: string;
  required: readonly RegExp[];
  forbidden: readonly RegExp[];
}>;

export type Grade = "correct" | "wrong" | "declined";

const PAPER = [
  /100,?412\.55/,
  /212\.30/,
  /45\.10/,
  /363,?200/,
  /2,?008(\.\d+)?\b/,
];
const NOT_AVAILABLE =
  /not available|isn't available|unavailable|no data|doesn't have|does not have|no (certified )?(term|source)|none of the certified terms|can(no|')t (see|tell|answer|give)/i;

export const EVAL_QUESTIONS: readonly EvalQuestion[] = [
  {
    forbidden: PAPER,
    id: "Q1",
    kind: "account",
    question: "What's my net liq right now?",
    reference: "248,350.12 USD (live IBKR account).",
    required: [/248,?350\.12/],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q2",
    kind: "account",
    question:
      "How much is 2% of my account? That is my max loss per new trade.",
    reference: "about 4,967 USD (2% of NLV 248,350.12).",
    required: [/4,?96[67]\b/],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q3",
    kind: "account",
    question: "How much money do I have at risk in open options right now?",
    reference:
      "11,830 USD maximum loss (NVDA calls 6,250 + SPY puts 4,380 + QQQ 520/530 call credit spread 1,200).",
    required: [/11,?(77\d|78\d|79\d|8[0-8]\d)\b/],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q4",
    kind: "account",
    question: "Is my open options risk above 6% of NLV?",
    reference: "No; about 4.76% of NLV (11,830 / 248,350).",
    required: [/4\.[78]\d*\s?%/, /\bno\b|below|under|less than|not above/i],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q5",
    kind: "account",
    question: "How did I do today?",
    reference: "Daily P&L -1,284.40 USD (a loss) on the live account.",
    required: [/1,?284\.40/],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q6",
    kind: "account",
    question: "What's my unrealized P&L?",
    reference: "5,830.00 USD on the live account.",
    required: [/5,?830(\.00)?\b/],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q7",
    kind: "account",
    question: "How many NVDA shares do I own?",
    reference: "150 shares (also 5 NVDA call contracts, optional).",
    required: [/\b150 (NVDA )?shares\b/i],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q8",
    kind: "account",
    question: "What are my SPY shares worth?",
    reference: "70,560 USD (120 shares).",
    required: [/70,?560/],
    set: "main",
  },
  {
    forbidden: [...PAPER, /\b\d+ (open )?(crown )?(copy )?legs\b/i],
    id: "Q9",
    kind: "not_available",
    question: "How many Crown copy legs are open right now?",
    reference: "Not available: Vertex has no Crown copy-book data.",
    required: [NOT_AVAILABLE],
    set: "main",
  },
  {
    forbidden: [...PAPER, /\d+(\.\d+)?\s?%/],
    id: "Q10",
    kind: "not_available",
    question: "What share of my NLV is in the Crown copy book?",
    reference: "Not available: Vertex has no Crown copy-book data.",
    required: [NOT_AVAILABLE],
    set: "main",
  },
  {
    forbidden: [...PAPER, /breakout 55|bollinger|macd/i],
    id: "Q11",
    kind: "research",
    question: "Which autopilot candidates passed the gate?",
    reference:
      "SPY sma-cross 20/50 (OOS Sharpe 0.91) and SPY rsi14 below 30 (OOS Sharpe 0.63).",
    required: [/sma-cross 20\/50/i, /rsi14 below 30/i],
    set: "main",
  },
  {
    forbidden: [...PAPER, /\b(three|3) candidates failed/i],
    id: "Q12",
    kind: "research",
    question: "How many candidates failed the gate in the SPY campaign?",
    reference: "2 (SPY breakout 55 and SPY bollinger 20/2).",
    required: [/\b(2|two)\b/i],
    set: "main",
  },
  {
    forbidden: [...PAPER, /\b1\.10\b/, /\b1\.9\b/],
    id: "Q13",
    kind: "research",
    question:
      "What's the Sharpe of the latest Opening Range Breakout backtest?",
    reference:
      "0.82 (latest succeeded engine run br_orb_2; the newest run br_orb_3 failed).",
    required: [/\b0\.82\b/],
    set: "main",
  },
  {
    forbidden: [...PAPER, /\b1\.9\b/],
    id: "Q14",
    kind: "research",
    question: "Which strategy has the best backtest Sharpe?",
    reference:
      "RSI Mean Reversion, Sharpe 1.45 (latest succeeded engine run per strategy).",
    required: [/rsi mean reversion/i, /\b1\.45\b/],
    set: "main",
  },
  {
    forbidden: [...PAPER, /\b11(\.0)?\s?%/, /\b14\.2\s?%/],
    id: "Q15",
    kind: "research",
    question: "What was the max drawdown in ORB's latest backtest?",
    reference: "18.9% (run br_orb_2).",
    required: [/\b18\.9\d*\s?%/],
    set: "main",
  },
  {
    forbidden: [...PAPER, /\b27(\.0)?\s?%/],
    id: "Q16",
    kind: "research",
    question: "Do any strategies have a backtest drawdown worse than 20%?",
    reference:
      "Yes: among strategies only Sector Momentum (22.5%). Engine runs with no strategy, per run spec, also exceed 20% (GLD smaCross 5/20 41.2%, IWM smaCross 10/30 25.8%); listing them labelled as run specs (not strategies) next to Sector Momentum is correct; presenting them as strategies is wrong.",
    required: [/sector momentum/i, /\b22\.50?\s?%/],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q17",
    kind: "research",
    question: "Are any deployment requests waiting for me?",
    reference:
      "Yes, one: Opening Range Breakout, SPY 5m, paper, requested 2026-11-04.",
    required: [/opening range breakout|\bORB\b/i],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q18",
    kind: "research",
    question: "Which strategy did I last approve for paper trading?",
    reference: "Sector Momentum (XLK 1d), approved 2026-10-30.",
    required: [/sector momentum/i],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "Q19",
    kind: "research",
    question: "Is any paper strategy drifting from its backtest?",
    reference:
      "Yes: Opening Range Breakout at alert and Sector Momentum at warn.",
    required: [/opening range breakout|\bORB\b/i, /sector momentum/i],
    set: "main",
  },
  {
    forbidden: [...PAPER, /sector momentum[^.]*\balert\b/i],
    id: "Q20",
    kind: "research",
    question: "Which drift monitors are in alert?",
    reference: "Only the ORB paper forward monitor (Opening Range Breakout).",
    required: [/ORB paper forward|opening range breakout/i],
    set: "main",
  },
  {
    forbidden: PAPER,
    id: "H1",
    kind: "account",
    question: "What's my account worth?",
    reference: "248,350.12 USD net liquidation of the live account.",
    required: [/248,?350\.12/],
    set: "held_out",
  },
  {
    forbidden: PAPER,
    id: "H2",
    kind: "account",
    question:
      "Is my NVDA option premium under the 2% of NLV cap for short-dated options?",
    reference:
      "No: the NVDA Dec 18 2026 calls cost 6,250 = about 2.52% of NLV 248,350; above the 2% cap.",
    required: [/2\.5[0-5]\d*\s?%/, /\bno\b|above|over|exceeds|not under/i],
    set: "held_out",
  },
  {
    forbidden: PAPER,
    id: "H3",
    kind: "account",
    question: "What's my realized P&L?",
    reference: "1,050.00 USD on the live account.",
    required: [/1,?050(\.00)?\b/],
    set: "held_out",
  },
  {
    forbidden: PAPER,
    id: "H4",
    kind: "research",
    question: "What's the win rate of RSI Mean Reversion's latest backtest?",
    reference: "61% (0.61, engine run br_mr_1).",
    required: [/\b61(\.0+)?\s?%|\b0\.61\b/],
    set: "held_out",
  },
  {
    forbidden: PAPER,
    id: "H5",
    kind: "not_available",
    question: "How much buying power do I have?",
    reference: "Not available: no certified term exposes live buying power.",
    required: [NOT_AVAILABLE],
    set: "held_out",
  },
  // Engine runs with no strategy (migration 0058): run_spec rows of backtest_sharpe and
  // backtest_max_drawdown, latest succeeded run per symbol, rule and timeframe. Older runs and
  // notebook records are wrong values.
  {
    forbidden: [...PAPER, /\b0\.64\b/],
    id: "U1",
    kind: "research",
    question: "What's the backtest Sharpe of the IWM SMA 10/30 runs?",
    reference:
      "0.71 (latest succeeded IWM smaCross 10/30 1d run br_free_iwm_2, per run spec; the runs have no strategy).",
    required: [/\b0\.71\b/],
    set: "unlinked",
  },
  {
    forbidden: [...PAPER, /\b1\.62\b/],
    id: "U2",
    kind: "research",
    question:
      "Among the backtests that aren't linked to a strategy, which one has the best Sharpe?",
    reference:
      "DIA breakout 20/10 with a 200 trend SMA (1m), Sharpe 1.21 (run br_free_dia_1, per run spec).",
    required: [/\bDIA\b/, /\b1\.21\b/],
    set: "unlinked",
  },
  {
    forbidden: [...PAPER, /\b31\.1\d*\s?%/],
    id: "U3",
    kind: "research",
    question:
      "Do any backtest runs without a strategy have a max drawdown worse than 20%?",
    reference:
      "Yes: GLD smaCross 5/20 (41.2%) and IWM smaCross 10/30 (25.8%), per run spec.",
    required: [/\bGLD\b/, /\b41\.20?\s?%/, /\bIWM\b/, /\b25\.80?\s?%/],
    set: "unlinked",
  },
  {
    forbidden: PAPER,
    id: "U4",
    kind: "research",
    question: "What was the max drawdown of the latest DIA breakout backtest?",
    reference:
      "8.3% (run br_free_dia_1; the newer DIA run failed). Per run spec; no strategy.",
    required: [/\b8\.30?\s?%/],
    set: "unlinked",
  },
  {
    forbidden: [...PAPER, /\b1\.9\b/, /\b1\.62\b/],
    id: "U5",
    kind: "research",
    question:
      "List the backtest Sharpe of every strategy and every unlinked engine run, and say which grouping each row uses.",
    reference:
      "Per strategy: RSI Mean Reversion 1.45, Sector Momentum 1.31, Opening Range Breakout 0.82. Per run spec (no strategy): DIA breakout 1.21, IWM smaCross 10/30 0.71, GLD smaCross 5/20 with a 2% stop loss 0.33, GLD smaCross 5/20 without a stop -0.12.",
    required: [
      /\b1\.45\b/,
      /\b1\.31\b/,
      /\b0\.82\b/,
      /\b1\.21\b/,
      /\b0\.71\b/,
      /-\s?0\.12\b|−0\.12\b/,
      /per strategy|by strategy|strategy grouping|(?<!un|not )linked to a strategy/i,
      /run spec|no strategy|without a strategy|unlinked|not linked/i,
    ],
    set: "unlinked",
  },
];

export const gradeAnswer = (question: EvalQuestion, answer: string): Grade => {
  if (question.forbidden.some((pattern) => pattern.test(answer)))
    return "wrong";
  if (question.required.every((pattern) => pattern.test(answer)))
    return "correct";
  return "declined";
};
