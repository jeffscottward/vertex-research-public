// What: one native contract fixture case, shared by fixtures.ts and the per-area fixture builders.
export interface ContractFixture {
  name: string;
  contract: string;
  payload: unknown;
  valid: boolean;
}
