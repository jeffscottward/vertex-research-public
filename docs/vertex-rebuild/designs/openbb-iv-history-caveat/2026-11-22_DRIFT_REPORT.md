# EGM Drift Report — OpenBB IV History Caveat

![Dark infographic showing row provenance, exact sample membership, and the audit-only fallback timestamp](openbb-iv-history-caveat.svg)

**Rerun:** 2026-11-22 by a fresh-context agent at `5ebc230960c942ef8471b49285228f96f33f6c45`. Each finding below is fixed in the next commit; the fix follows each item.

## concepts_brief.md

* The newest-run notice did not say that it and the IV table are separate reads. Fixed: the notice now says so.
* The notice said "Values differ from the Cboe series of earlier rows", which implied earlier rows are Cboe. Fixed: the notice now says Yahoo values differ from Cboe values and points to the IV history column.

## design_draft.md

No drift detected.

## plan.md

* The same notice wording implied unverified history was Cboe. Fixed with the notice change above.
* Phase 1 said not to add the sample-derived history query yet; the code adds it with the source column. Fixed: the plan now matches the canonical design.

## openbb-iv-history-caveat.md

* `OpenbbOptionIvDailySource` and `OpenbbIvHistoryState` are not code types. Fixed: the Domain shapes section now names them as domain names and points to the CHECK constraint, `OpenbbOptionIvDailyProducerSourceSchema`, and the `historyState` contract enum.
* The design said the API maps an omitted source to `unknown`; the API leaves it unset and the database default stores `unknown`. Fixed: the design now states the actual behavior.
* The notice wording conflicted with the `historyState` caveat. Fixed with the notice change above.
