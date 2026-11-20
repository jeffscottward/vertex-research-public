// A metric with no value names its cause instead of a dash or "n/a".
// "Not defined" means the metric has no value for this data (for example no losing trades);
// "Not computed" means an input it needs is missing. Each cause string is defined once here.

export const notDefined = (cause: string): string => `Not defined: ${cause}`;
export const notComputed = (cause: string): string => `Not computed: ${cause}`;

export const CAUSE_NO_CLOSED_TRADES = "no closed trades";
export const CAUSE_NO_LOSING_TRADES = "no losing trades";
export const CAUSE_NO_WINNING_TRADES = "no winning trades";
export const CAUSE_NO_LOSING_PERIODS = "no losing periods";
export const CAUSE_FEW_EQUITY_POINTS = "fewer than 3 equity points";
export const CAUSE_INPUT_MISSING = "an input is missing from this report";
export const CAUSE_FLAT_RETURNS = "flat returns";
export const CAUSE_PERIOD_TOO_SHORT = "period too short";
export const CAUSE_SHARPE_UNDEFINED =
  "the Sharpe ratio is not defined for this run";
export const CAUSE_ZERO_DRAWDOWN = "no drawdown";
export const VALIDATION_GATE_NOT_RUN = "Validation gate not run";

/** Profit factor is gross win / gross loss: undefined without closed or losing trades. */
export const profitFactorNullText = (trades: number): string =>
  notDefined(trades === 0 ? CAUSE_NO_CLOSED_TRADES : CAUSE_NO_LOSING_TRADES);
