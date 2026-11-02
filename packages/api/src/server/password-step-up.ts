// Password step-up with a lockout, shared by the Academy rule override and the Nautilus arm switch.
// The attempt is audited before the check, so parallel requests all see each other: failed and
// still-unresolved attempts count toward PASSWORD_FAILURE_LIMIT. Only an invalid password is a failure;
// an auth or storage outage is "error" and does not count. Callers map the outcome to their own errors.

export const PASSWORD_FAILURE_LIMIT = 5;
export const PASSWORD_FAILURE_WINDOW_MS = 15 * 60_000;

export type StepUpStage = "attempt" | "verified" | "error" | "failed";

// Audit storage for one feature: record one stage row; count one stage's rows for this user since a time.
export type StepUpLedger = Readonly<{
  record: (stage: StepUpStage) => Promise<unknown>;
  countSince: (stage: StepUpStage, since: Date) => Promise<number>;
}>;

export type StepUpOutcome =
  | Readonly<{ kind: "verified" }>
  | Readonly<{ kind: "locked" }>
  | Readonly<{ kind: "error" }>
  // attempt: this failure's number within the window (1..PASSWORD_FAILURE_LIMIT).
  | Readonly<{ kind: "failed"; attempt: number }>;

export const passwordStepUp = async (
  ledger: StepUpLedger,
  verifyPassword: (password: string) => Promise<boolean>,
  password: string,
  nowMs: number = Date.now()
): Promise<StepUpOutcome> => {
  await ledger.record("attempt");
  const since = new Date(nowMs - PASSWORD_FAILURE_WINDOW_MS);
  const attempts = await ledger.countSince("attempt", since);
  const resolvedOk =
    (await ledger.countSince("verified", since)) +
    (await ledger.countSince("error", since));
  // Earlier attempts that failed or are still being checked (this attempt excluded).
  const failures = attempts - 1 - resolvedOk;
  if (failures >= PASSWORD_FAILURE_LIMIT) {
    await ledger.record("failed");
    return { kind: "locked" };
  }
  let verified: boolean;
  try {
    verified = await verifyPassword(password);
  } catch {
    await ledger.record("error");
    return { kind: "error" };
  }
  if (verified) {
    await ledger.record("verified");
    return { kind: "verified" };
  }
  await ledger.record("failed");
  return { attempt: failures + 1, kind: "failed" };
};
