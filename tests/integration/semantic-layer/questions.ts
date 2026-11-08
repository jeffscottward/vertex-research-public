// The 25 owner-style questions of docs/vertex-rebuild/agent-semantic-layer.md (Q1-Q20 main set, H1-H5
// held-out set) with a fixed grading rubric over the synthetic fixture (fixture.sql + the feed fixtures in
// fixtures.ts). Grades:
// - correct: every `required` pattern matches and no `forbidden` pattern matches;
// - wrong: a `forbidden` pattern matches (a value from the wrong source or a wrong value);
// - declined: anything else (no wrong value, but the required value is missing).
// Paper exec-node values (deployment_status) are forbidden in every answer: an account answer must come
// from the live account, and quoting the paper value next to it invites the error this layer prevents.

export type QuestionKind = "account" | "research" | "not_available";
export type QuestionSet = "main" | "held_out";

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
    reference: "Yes, only Sector Momentum (22.5%).",
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
];

export const gradeAnswer = (question: EvalQuestion, answer: string): Grade => {
  if (question.forbidden.some((pattern) => pattern.test(answer)))
    return "wrong";
  if (question.required.every((pattern) => pattern.test(answer)))
    return "correct";
  return "declined";
};
