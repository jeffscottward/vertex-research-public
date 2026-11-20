# Knowledge-base adviser records: history-ibapi-10-30

Answers of the kb-chat knowledge-base agents used as advisers for this design (owner delegation 2026-11-20 UTC). One entry per record; question and answer verbatim in text blocks (long section texts shortened). All agents state that their sources do not cover this subject and answer from general practice. Entry names: `kb-*` decision B; `D1`-`D4`, `D4b` architecture picks (`D4` rests on a wrong premise, replaced by `D4b`); `D2r`, `Br` re-decisions after the egm-review; `sec*` section approvals; `contra-*` brief-versus-draft reconciliation.

## Record Br-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Re-decision after a design review. Decision B said: when a reader receives an old-format answer (stock volume in unknown lots), show no stock volume instead of a wrong number. The review found that three of the four readers already fall back to a second source (Yahoo, consolidated volume in shares) whenever the broker service fails. Options: A: keep B as decided: every reader accepts old and new formats and shows no stock volume for old-format answers (needs code for both formats in all four readers, and pages show no volume until the service upgrade is deployed). B: the three readers with a fallback accept only the new format and treat an old-format answer like a broker failure, so Yahoo's share volume is shown (a correct number from another source, about 1.45 times the broker's own count); only the chart reader, which has no fallback, shows no volume for old-format answers. Both options never show a wrong number.
```

Answer:

```text
Choice: B

- **My sources don't cover this.** The retrieved evidence is a KB overview (source_id `kb-deepedgeintelligence-bdf2f65de8fa:README.md`, publication date unknown, no URL) and one macro-dashboard reel (`raw/ig-DcGguB9oXDo.md`, "The US economy in one dashboard," 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/). Neither covers volume lot units or reader fallback design. The archive has 74 listed posts. My evidence gives no count of missing or deferred transcripts. The reasons below are general engineering practice, not sourced claims.
- **Reuse the existing path.** Treating an old-format answer as a broker failure uses the fallback three readers already have. That means less code for both formats and fewer edge cases, and pages show a correct number before the upgrade instead of nothing.
- **The source change must be visible.** Yahoo's consolidated count is about 1.45× the broker's own count. Label the volume source on screen so the jump isn't read as real volume growth, and log each fallback. The chart reader keeps decision B's no-volume rule.
```

## Record Br-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Re-decision after a design review. Decision B said: when a reader receives an old-format answer (stock volume in unknown lots), show no stock volume instead of a wrong number. The review found that three of the four readers already fall back to a second source (Yahoo, consolidated volume in shares) whenever the broker service fails. Options: A: keep B as decided: every reader accepts old and new formats and shows no stock volume for old-format answers (needs code for both formats in all four readers, and pages show no volume until the service upgrade is deployed). B: the three readers with a fallback accept only the new format and treat an old-format answer like a broker failure, so Yahoo's share volume is shown (a correct number from another source, about 1.45 times the broker's own count); only the chart reader, which has no fallback, shows no volume for old-format answers. Both options never show a wrong number.
```

Answer:

```text
Choice: B

- **My sources don't cover this.** My retrieved evidence is about quant concepts: implied volatility and risk parity in *QuantFinanceToGo concepts* (source_id kb-quantfinancetogo-bdac178174f6:concepts.md, date unknown, no URL), and GJR GARCH in Part 40 (raw/ig-DfRnjfGRKH-.md, 2026-11-03, https://www.instagram.com/reel/DfRnjfGRKH-/). None of it covers feed formats, volume units or fallback design. The structured index is also stale. Everything below is general practice.
- **Less code, same safety.** Three readers already have a tested Yahoo fallback. Treating an old-format answer as a broker failure reuses that path. No reader needs code for both formats, and no wrong number is shown.
- **Pages keep showing data.** Pages show a correct share volume now, not a blank until the upgrade ships. Two things are needed: label the source on screen ("consolidated, Yahoo"), and never mix it with broker counts. Yahoo's figure is about 1.45 times the broker's count, so comparing them would mislead. The chart reader still shows no volume for old-format answers.
```

## Record D1-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Where should the installer of a read-only market-data service get a pinned broker API client (Python package, same bytes either way, verified by SHA-256 and a source-tree hash)? A: download the wheel from PyPI (package nautilus-ibapi 10.30.1, published by a third party that repackages the broker's official source) at install time, pinned by URL and SHA-256. Fails if PyPI is unreachable; no dependency on other systems on the host. B: copy the identical wheel read-only from the trading engine's vendored folder on the same host (/opt/vertex-exec-node/.../ibapi-10.30.1-py3-none-any.whl), pinned by SHA-256. No network; the install fails if the trading engine later removes or changes that file, and the history service then depends on another component's files. (The broker no longer serves this version itself.)
```

Answer:

```text
Choice: A

- **KB gap:** My sources don't cover this. The two retrieved items are a reel about building multiple Expert Advisors (source_id `kb-deepedgeintelligence-bdf2f65de8fa:raw/ig-DdOuUQQokHb.md`, published 2026-09-13, https://www.instagram.com/reel/DdOuUQQokHb/) and the KB README (publication date and URL unknown). Neither says anything about packaging, PyPI or dependency isolation. Everything below is general engineering practice, not KB evidence.
- **Isolation:** Option B makes the read-only history service depend on the trading engine's private vendored folder. A routine engine upgrade could break its installs. It also ties a read-only component to execution infrastructure, which weakens that boundary.
- **Integrity holds either way:** The SHA-256 pin plus the source-tree hash make the PyPI bytes as trustworthy as the local copy, even though a third party publishes the package. PyPI being unreachable is a loud, retryable failure. To reduce that risk, mirror the pinned wheel to your own artifact store rather than borrowing another component's files.
```

## Record D1-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Where should the installer of a read-only market-data service get a pinned broker API client (Python package, same bytes either way, verified by SHA-256 and a source-tree hash)? A: download the wheel from PyPI (package nautilus-ibapi 10.30.1, published by a third party that repackages the broker's official source) at install time, pinned by URL and SHA-256. Fails if PyPI is unreachable; no dependency on other systems on the host. B: copy the identical wheel read-only from the trading engine's vendored folder on the same host (/opt/vertex-exec-node/.../ibapi-10.30.1-py3-none-any.whl), pinned by SHA-256. No network; the install fails if the trading engine later removes or changes that file, and the history service then depends on another component's files. (The broker no longer serves this version itself.)
```

Answer:

```text
Choice: A

- **My sources don't cover this.** The two retrieved sources are my reels on APT (kb-quantfinancetogo-bdac178174f6:raw/ig-Dfeu_BMxSc6.md, part 44, 2026-11-08, https://www.instagram.com/reel/Dfeu_BMxSc6/) and GJR GARCH (raw/ig-DfRnjfGRKH-.md, part 40, 2026-11-03, https://www.instagram.com/reel/DfRnjfGRKH-/). Neither covers software supply chains. No video IDs were available, and the structured index is stale. Everything below is general practice.
- **Isolation:** With B, the read-only data service would depend on the trading engine's private vendored folder. If that engine changes or removes the file, the history service breaks. A read-only service shouldn't be tied to an execution component.
- **Integrity is the same:** The SHA-256 and source-tree hash already prove the bytes match, so the third-party publisher adds little risk. To handle a PyPI outage, mirror the pinned wheel into the service's own artifact store. Don't borrow another component's copy.
```

## Record D2-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
How should the installer swap the client environment of a small read-only market-data service (systemd unit runs /opt/vertex-history/venv/bin/python /opt/vertex-history/vertex_history.py)? A: build and test the new venv in a staging folder, then rename it into place together with the new code in one step; the old venv and code are moved into a dated rollback folder; rollback = rename them back. B: build an immutable release folder per version (code + venv), test it there, and switch symlinks /opt/vertex-history/venv and /opt/vertex-history/vertex_history.py to it; old releases stay on disk; rollback = point the symlinks back; needs pruning of old folders. Both keep the unit file unchanged and restart only this service.
```

Answer:

```text
Choice: B

1. **Atomic and easy to reverse.** Each version lives in its own folder with its code and venv, and you test it there. Changing a symlink with `ln -sfn` plus `mv -T` is one atomic rename. Rollback just points the links back to the old folder, which is still on disk. In A, the venv and the code are two separate renames, so they are not truly "one step." A venv moved to a new path can also break, because its scripts and `pyvenv.cfg` contain absolute paths. B avoids that: build each venv at its final release path.
2. **Easier to check.** `readlink` shows which version is running. The unit file stays the same, and you restart only this service. Pruning old releases is a small, scriptable cost.
3. **Source coverage.** My archive has nothing on deployment practice. SOURCE 1 (ig-Dcjc5I7ojQd, 2026-08-27, https://www.instagram.com/reel/Dcjc5I7ojQd/) is about Jackson Hole and markets. SOURCE 2 (README, date unknown) covers 74 posts dated 2026-07-29 to 2026-10-22, with 0 missing transcripts. This answer is general practice only.
```

## Record D2-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
How should the installer swap the client environment of a small read-only market-data service (systemd unit runs /opt/vertex-history/venv/bin/python /opt/vertex-history/vertex_history.py)? A: build and test the new venv in a staging folder, then rename it into place together with the new code in one step; the old venv and code are moved into a dated rollback folder; rollback = rename them back. B: build an immutable release folder per version (code + venv), test it there, and switch symlinks /opt/vertex-history/venv and /opt/vertex-history/vertex_history.py to it; old releases stay on disk; rollback = point the symlinks back; needs pruning of old folders. Both keep the unit file unchanged and restart only this service.
```

Answer:

```text
Choice: B

My QuantFinanceToGo sources don't cover this. The retrieved reels are about finance models: Black-Litterman (`raw/ig-DfchQKCRSx7.md`, 2026-11-07, https://www.instagram.com/reel/DfchQKCRSx7/) and GARCH (`raw/ig-DfPHPULRYE7.md`, 2026-11-02, https://www.instagram.com/reel/DfPHPULRYE7/). Neither says anything about installers, venvs or systemd. The reasons below come from general practice, not from cited evidence.

1. **Venvs depend on their path.** A venv stores absolute paths in its scripts and `pyvenv.cfg`. Option A builds it in staging and then renames it, which can break scripts and `pip`. Option B builds and tests each venv in its final folder and never moves it.
2. **Rollback is cleaner.** Old releases stay unchanged, so rolling back only means pointing the symlinks back.
3. **Fix the remaining gap.** Switching two symlinks separately isn't atomic either. Use one `current` symlink to the release folder, create it under a temp name, then `mv -T` it into place. Prune old releases by count.
```

## Record D2r-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Re-decision after a design review. Earlier you chose immutable release folders switched by symlinks for installing a new client environment for a small read-only market-data service. The review found: (1) the plan switches two symlinks (code and venv) one after another, so a failure between them can still mix them, the same flaw used to reject the other option; (2) release folders are a new pattern here: every other installer on this host keeps a dated rollback-<timestamp> backup folder; (3) only the venv and one code file would live in the release folder, while the unit file, a helper script and a web-server config are still installed in place; (4) the deploy tool copies only five fixed files. Options now: A: keep release folders but with a single 'current' symlink as the only thing that changes (one atomic rename), plus a one-time migration and pruning rules that never delete the rollback target. B: build a new venv folder named after the client hash next to the old one, test it, then install the code and point the unit's ExecStart at the new venv in one step; the dated rollback folder keeps the previous code, unit file and venv path, and rollback restores them (the existing pattern on this host).
```

Answer:

```text
Choice: B

1. **It fits the host's existing pattern.** Every other installer here uses a dated rollback-<timestamp> folder. B keeps that pattern. A would need a one-time migration and new pruning rules, which add new ways to fail. This is my own reasoning. My KB doesn't cover deploy design.
2. **B's single step covers all the files that change.** Here the unit file, helper script and web-server config stay in place, so A's one symlink can't switch everything at once. In B, the new venv is built and tested first, then one change to ExecStart in the unit file switches over. Rollback restores the code, the unit file and the venv path together. Make that switch one atomic file replace plus a daemon-reload, and check it in review. This is general practice, not from my sources.
3. **No source support.** The only relevant source I found is "The US economy in one dashboard" (kb-deepedgeintelligence-bdf2f65de8fa:raw/ig-DcGguB9oXDo.md, 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/). It's about macro data, not installers. My KB has no evidence on deploy patterns, and its full archive coverage and missing transcript counts weren't provided.
```

## Record D2r-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Re-decision after a design review. Earlier you chose immutable release folders switched by symlinks for installing a new client environment for a small read-only market-data service. The review found: (1) the plan switches two symlinks (code and venv) one after another, so a failure between them can still mix them, the same flaw used to reject the other option; (2) release folders are a new pattern here: every other installer on this host keeps a dated rollback-<timestamp> backup folder; (3) only the venv and one code file would live in the release folder, while the unit file, a helper script and a web-server config are still installed in place; (4) the deploy tool copies only five fixed files. Options now: A: keep release folders but with a single 'current' symlink as the only thing that changes (one atomic rename), plus a one-time migration and pruning rules that never delete the rollback target. B: build a new venv folder named after the client hash next to the old one, test it, then install the code and point the unit's ExecStart at the new venv in one step; the dated rollback folder keeps the previous code, unit file and venv path, and rollback restores them (the existing pattern on this host).
```

Answer:

```text
**Choice: B**

My knowledge base doesn't cover deployment. Both retrieved sources are about quant finance: the low-volatility anomaly (kb-quantfinancetogo-bdac178174f6:raw/ig-DerWwTTiKGS.md, 2026-10-19, instagram.com/reel/DerWwTTiKGS/) and the season 1 recap (raw/ig-DeCw2yPRF6M.md, 2026-10-03, instagram.com/reel/DeCw2yPRF6M/). These reasons come from general practice only:

1. **A's atomic switch covers too little.** The unit file, helper script and web-server config are still installed in place. One atomic `current` rename doesn't make the whole release atomic. B's dated rollback folder saves all of these together.
2. **B follows the host's existing pattern.** Every other installer uses `rollback-<timestamp>`. B needs no migration or new pruning rules, and it fits a deploy tool that copies five fixed files.
3. **B makes one change that matters.** The service only uses the new venv after the ExecStart edit, a `daemon-reload` and a restart. The hash-named venv is built and tested first, and the old venv stays on disk until rollback is no longer needed.
```

## Record D3-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
A market-data service also serves order-book depth. After a client upgrade, the broker no longer sends a 'size multiplier' (old value 40 for US stocks), so depth sizes are probably now in shares, but this cannot be measured before the deploy (only historical requests are allowed in tests). Depth sizes are stored all day by a collector. Which is better? A: keep the depth answer format name, report sizeMultiplier 1, and check one live depth read right after the deploy; on a fail, roll the service back (minutes of possibly wrong stored depth). B: give depth answers a new format version with an explicit size unit field ('shares' after the check passes); readers store or show depth sizes only for that version; until the check passes the service marks the unit as unknown and the collector skips storing sizes (more code in 3 readers, no wrong stored rows).
```

Answer:

```text
Choice: B

- **No wrong rows stored.** The collector stores depth all day. Under A, a failed check still leaves minutes of rows off by up to 40×, and rolling back the service does not fix rows already stored. B stores nothing until the unit is confirmed, so a missing value cannot be mistaken for a real one. (This is general practice. My KB does not cover it.)
- **The unit is stated, not guessed.** Keeping the old format name with sizeMultiplier 1 rests on an assumption you can't test before the deploy. With a versioned format and an explicit `unit` field, readers have to check the unit and can't treat old and new data the same way by mistake. (General practice.)
- **What my sources cover.** My KB is 74 Instagram reels from 2026-07-29 to 2026-10-22, all transcribed, none missing. The only matching source is about a macro Excel dashboard ("The US economy in one dashboard", `kb-deepedgeintelligence-bdf2f65de8fa:raw/ig-DcGguB9oXDo.md`, 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/). It says nothing about order-book depth, size multipliers or data versioning, so neither choice has support from my sources.

The cost of B is extra code in 3 readers, which is worth it to avoid wrong stored rows.
```

## Record D3-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
A market-data service also serves order-book depth. After a client upgrade, the broker no longer sends a 'size multiplier' (old value 40 for US stocks), so depth sizes are probably now in shares, but this cannot be measured before the deploy (only historical requests are allowed in tests). Depth sizes are stored all day by a collector. Which is better? A: keep the depth answer format name, report sizeMultiplier 1, and check one live depth read right after the deploy; on a fail, roll the service back (minutes of possibly wrong stored depth). B: give depth answers a new format version with an explicit size unit field ('shares' after the check passes); readers store or show depth sizes only for that version; until the check passes the service marks the unit as unknown and the collector skips storing sizes (more code in 3 readers, no wrong stored rows).
```

Answer:

```text
Choice: B

1. **No wrong rows get stored.** The collector stores depth all day. Under A, a failed check still leaves minutes of rows whose sizes could be off by 40×, and you can't easily tell those rows apart later. B stores sizes only after the unit is confirmed. This is general data-engineering practice. My knowledge base doesn't cover market-data pipelines or order-book units.
2. **The unit is stated, not assumed.** Reporting `sizeMultiplier 1` under the old format name looks the same whether the unit was checked or guessed. A new format version with a `unit` field that can be "unknown" makes readers handle the uncertainty. This is also general practice, not from my sources.
3. **Bad inputs spread into later numbers.** Source 2 (kb-quantfinancetogo-bdac178174f6:raw/ig-De4D23VCl2E.md, "Part 31… implied volatility," 2026-10-24, https://www.instagram.com/reel/De4D23VCl2E/) shows a computed value depending on its inputs. Applying that to stored depth sizes is my own reasoning, not the source's claim.

**Cost:** B needs more code in 3 readers.

**Coverage:** The archive and transcript counts weren't supplied.
```

## Record D4-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Four readers (two in the web API package, one standalone research script, one Python research module) parse the same bars answer and each kept its own copy of a volume-unit constant, which drifted. For the new answer version, which is better? A: keep four small parsers, remove the constant everywhere, and add one shared test fixture (the same sample answers v1 and v2) that every reader's tests load, so drift fails the tests. B: make the two web readers and the research script use one TypeScript parser module (the script can import it), keep the Python reader separate, and share the same test fixture. More code moves now, fewer copies later.
```

Answer:

```text
Choice: B

- **One TS parser removes the drift source.** The two web readers and the script were separate copies of the same logic, so the constant drifted. Merging them into one module leaves two parsers (TS and Python) instead of four. The fixture then only has to keep those two in line. This is general engineering practice, not from my sources.
- **The shared v1/v2 fixture still matters.** The Python reader can't import TS code, so the same sample answers are the only check that it matches. B keeps that fixture. A adds it too, but a fixture only catches drift that someone wrote a test for. Fewer copies means fewer gaps. Also general practice.
- **My sources don't cover this.** My KB is Instagram market and macro reels. The overview (kb-deepedgeintelligence-bdf2f65de8fa:README.md, date unknown, no URL) and the Jackson Hole reel (raw/ig-Dcjc5I7ojQd.md, 2026-08-27, https://www.instagram.com/reel/Dcjc5I7ojQd/) say nothing about parsers or volume units. The archive has 74 posts. This run doesn't give missing-transcript counts.
```

## Record D4-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Four readers (two in the web API package, one standalone research script, one Python research module) parse the same bars answer and each kept its own copy of a volume-unit constant, which drifted. For the new answer version, which is better? A: keep four small parsers, remove the constant everywhere, and add one shared test fixture (the same sample answers v1 and v2) that every reader's tests load, so drift fails the tests. B: make the two web readers and the research script use one TypeScript parser module (the script can import it), keep the Python reader separate, and share the same test fixture. More code moves now, fewer copies later.
```

Answer:

```text
Choice: B

- **My sources don't cover this.** The two retrieved reels are about risk parity (kb-quantfinancetogo-bdac178174f6:raw/ig-DfZSXlgxRCt.md, "Quantitative Finance from Scratch, part 42: Risk Parity.", 2026-11-06, https://www.instagram.com/reel/DfZSXlgxRCt/) and the volatility smile (raw/ig-DfNAhn7iHRa.md, 2026-11-01, https://www.instagram.com/reel/DfNAhn7iHRa/). Neither discusses parsers, unit constants or test fixtures. The structured index is stale, so I could not check the full archive or count missing transcripts. The reasons below are general engineering practice only.
- **Fewer places to drift:** In B, three TypeScript readers share one parser, so only one TypeScript copy plus the Python copy can disagree. In A, all four parsers can still drift on anything the fixture doesn't test.
- **The shared fixture still matters:** It is the contract between TypeScript and Python, which B has to keep separate. Load the v1 and v2 sample answers in both test suites.
- **The extra cost is small:** The script can already import the module, so B costs one migration now, and every later format version needs fewer edits.
```

## Record D4b-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Correction to an earlier question. Four readers parse the same bars answer and each kept its own copy of a volume-unit constant, which drifted. The earlier option "one TypeScript parser for the two web readers and the research script" is not possible: the research script runs on a separate machine from an extracted folder that cannot import the web package, and it validates by hand without the validation library. Which is better now? A: the two web readers share one parser module in the web package; the research script keeps its own hand-written parser; the Python reader stays separate; all three parsers load one shared folder of sample answers (v1 and v2) in their tests, so any drift fails the tests. B: write one dependency-free parser inside the research-script folder and make the web package import it from there (the web package would then depend on a scripts folder, which the repository architecture rules discourage); Python stays separate; same shared sample answers.
```

Answer:

```text
Choice: A

1. **My sources don't cover this.** My knowledge base holds transcripts of DeepEdge Intelligence Instagram reels about markets and macro. Source 1, "Jackson Hole Incoming…" (kb-deepedgeintelligence-bdf2f65de8fa:raw/ig-Dcjc5I7ojQd.md, 2026-08-27, https://www.instagram.com/reel/Dcjc5I7ojQd/), is about Fed speeches moving markets. Nothing I retrieved covers parser design, unit constants or test fixtures. The structured index is also stale, so the reasons below come from general engineering practice.

2. **A follows the architecture rules.** Both web readers share one module, so their drift ends there. B makes the web package depend on a scripts folder, which your rules discourage. It also ties a shipped product to a research tool that has no validation library.

3. **Shared sample answers catch drift between the three parsers.** All three parsers load the same v1 and v2 samples in their tests, so a changed volume unit fails the tests. To prevent drift in the constant itself, keep it in the sample folder, for example in a small JSON file that all three parsers read.
```

## Record D4b-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Correction to an earlier question. Four readers parse the same bars answer and each kept its own copy of a volume-unit constant, which drifted. The earlier option "one TypeScript parser for the two web readers and the research script" is not possible: the research script runs on a separate machine from an extracted folder that cannot import the web package, and it validates by hand without the validation library. Which is better now? A: the two web readers share one parser module in the web package; the research script keeps its own hand-written parser; the Python reader stays separate; all three parsers load one shared folder of sample answers (v1 and v2) in their tests, so any drift fails the tests. B: write one dependency-free parser inside the research-script folder and make the web package import it from there (the web package would then depend on a scripts folder, which the repository architecture rules discourage); Python stays separate; same shared sample answers.
```

Answer:

```text
Choice: A

- **The sources don't cover this.** The retrieved reels are about option pricing (Part 30, Black-Scholes, `kb-quantfinancetogo-bdac178174f6:raw/ig-Dey6117Chzb.md`, 2026-10-22, https://www.instagram.com/reel/Dey6117Chzb/) and factor models (Part 44, APT, `kb-quantfinancetogo-bdac178174f6:raw/ig-Dfeu_BMxSc6.md`, 2026-11-08, https://www.instagram.com/reel/Dfeu_BMxSc6/). Neither discusses parser design. The reasons below are general engineering practice.
- **The shared sample answers are what catch drift.** If all three parsers test against the same v1 and v2 sample answers, any change to the volume unit fails a test. Code sharing is less important. One small parallel: Part 30 checks its formula price (9.93) against an independent Monte Carlo result (9.92). That is checking against a separate reference, not forcing two implementations into one.
- **B breaks the architecture rules.** It would make the web package depend on a scripts folder, so cleanup of that folder could break production. A follows the rules and still shares code where an import is possible, between the two web readers.

Archive limit: the structured index is stale and was not used.
```

## Record contra-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Finalizing a design for upgrading a broker market-data client (Forex bars load, stock volume in shares, no wrong number ever shown). The design draft differs from its earlier brainstorm brief in five places. Decide each.

Contradictions between the brainstorm brief and the final design draft. For each, answer "draft" or "brief" with one reason.

C1. Brief: the installer compares the client with the one in the Nautilus trader container. Draft: the pinned wheel hash and source-tree hash are the only gate; no command runs in the trading container.
C2. Brief: old-format (v1) answers give null volume for US stocks only. Draft: v1 gives null volume for all stocks in any currency, and new-format answers for non-USD stocks have unit "unknown" (null volume) because non-USD stock volume was not measured with the new client.
C3. Brief: the broker's "unset" size marker becomes null in bars, ticks and depth. Draft: null in bars; ticks and depth levels with an unset size are dropped and counted, because the tick and depth formats do not allow null sizes.
C4. Brief: depth keeps its format with sizeMultiplier 1 and is checked once after the deploy. Draft: depth gets a new format version with a size unit per security type; stock depth sizes are not stored until a live check passes (decision D3).
C5. Brief: a new venv when the installed client differs, the old venv kept in the rollback folder. Draft: immutable release folders (code + venv) switched by symlinks (decision D2).

```

Answer:

```text
Decision: approve

My knowledge base doesn't cover these points. The archive has 74 Instagram reels (2026-07-29 to 2026-10-22, all transcribed: 71 with speech, 3 without), built 2026-10-23 (README.md, date unknown). Transcripts were never checked against the audio. The only source I retrieved is the NYSE tick index reel (ig-Dey7tMKiMsO, 2026-10-22, https://www.instagram.com/reel/Dey7tMKiMsO/), and it says nothing about client design. Every answer below comes from general engineering practice.

- **C1: draft.** Pinned wheel and source hashes give a gate you can reproduce. Running commands in the live trading container adds risk and couples the installer to the container.
- **C2: draft.** If volume units weren't measured, return null. That fits "no wrong number ever shown." Limiting it to US stocks assumes units nobody checked.
- **C3: draft.** The tick and depth formats don't allow null sizes, so sending null would break readers. Dropping those items and counting them keeps the data correct and the loss visible.
- **C4: draft.** Depth needs a new format version with units per security type. Otherwise old readers would misread sizes. Holding stock depth until a live check passes stops unverified sizes from being stored.
- **C5: draft.** Immutable release folders switched by symlink give atomic switch and rollback. Patching a venv in place can leave mixed states.

No changes needed.
```

## Record contra-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Finalizing a design for upgrading a broker market-data client (Forex bars load, stock volume in shares, no wrong number ever shown). The design draft differs from its earlier brainstorm brief in five places. Decide each.

Contradictions between the brainstorm brief and the final design draft. For each, answer "draft" or "brief" with one reason.

C1. Brief: the installer compares the client with the one in the Nautilus trader container. Draft: the pinned wheel hash and source-tree hash are the only gate; no command runs in the trading container.
C2. Brief: old-format (v1) answers give null volume for US stocks only. Draft: v1 gives null volume for all stocks in any currency, and new-format answers for non-USD stocks have unit "unknown" (null volume) because non-USD stock volume was not measured with the new client.
C3. Brief: the broker's "unset" size marker becomes null in bars, ticks and depth. Draft: null in bars; ticks and depth levels with an unset size are dropped and counted, because the tick and depth formats do not allow null sizes.
C4. Brief: depth keeps its format with sizeMultiplier 1 and is checked once after the deploy. Draft: depth gets a new format version with a size unit per security type; stock depth sizes are not stored until a live check passes (decision D3).
C5. Brief: a new venv when the installed client differs, the old venv kept in the rollback folder. Draft: immutable release folders (code + venv) switched by symlinks (decision D2).

```

Answer:

```text
Decision: revise

**Evidence status:** My archive doesn't cover this. The retrieved sources are Black-Litterman, part 43 (kb-quantfinancetogo-bdac178174f6:raw/ig-DfchQKCRSx7.md, 2026-11-07, https://www.instagram.com/reel/DfchQKCRSx7/) and GJR GARCH, part 40 (raw/ig-DfRnjfGRKH-.md, 2026-11-03, https://www.instagram.com/reel/DfRnjfGRKH-/). Neither is about broker clients, volume units or deployment. I don't have archive coverage or missing-transcript counts for this run. Everything below is general engineering reasoning, not something from my sources.

- **C1: draft, but revise.** Pinned wheel and source hashes are a reproducible gate. Not touching the trading container is safer. Change: add a read-only version check against the Nautilus container's client, as a warning only.
- **C2: draft.** If volume units weren't measured, showing them risks wrong numbers. Null or "unknown" is the safe choice.
- **C3: draft, but revise.** If the format can't hold null, dropping the item and counting it beats inventing a size. Change: show the dropped counts in monitoring and alert on them.
- **C4: draft.** Depth sizes differ by security type, so they need an explicit unit. Holding stock depth sizes until the live check passes (D3) avoids showing wrong values. A single check after deploy isn't enough.
- **C5: draft.** Immutable release folders switched by symlink give atomic rollback. Keeping a loose old venv doesn't.

Not financial advice.
```

## Record kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
A charting and research system reads daily bar volume from a broker data service. During a client upgrade, some answers may still arrive in an old format whose stock volume is in unknown lot sizes (one value we checked was 40 shares per unit; the old code multiplied by 100, so it showed 2.5 times the true volume). For those old-format answers only, which is better practice? A: keep showing the old scaled number (known to be wrong by about 2.5x) until the upgrade finishes. B: mark the volume as missing (no number) for those answers, and make every calculation treat missing volume as missing, not as zero. C: have the service send both formats so old readers get a corrected number. Prices are correct in all three cases.
```

Answer:

```text
Choice: B

1. **A wrong number is worse than a missing one.** Option A keeps showing volume that is about 2.5x too high. That error flows silently into VWAP, liquidity screens, volume ratios and backtests. If you mark the value as missing, nobody consumes bad data, and treating missing as missing rather than zero stops averages and signals from being skewed. This is general data-engineering practice, not something my sources say.
2. **Option C doesn't fix the real problem.** The lot size is unknown and can vary, as your 40-shares-per-unit example shows. A "corrected" number for old readers would still need a lot size you can't reliably know. It would also add a second format to keep in sync during the upgrade. This is my own reasoning.
3. **My knowledge base doesn't cover this.** The closest source (`raw/ig-DcGguB9oXDo.md`, "The US economy in one dashboard", 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/) is about collecting macro data in Excel, not handling volume units. The transcripts haven't been checked against the audio, so numbers in them may be wrong (README, date unknown, no URL).
```

## Record kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
A charting and research system reads daily bar volume from a broker data service. During a client upgrade, some answers may still arrive in an old format whose stock volume is in unknown lot sizes (one value we checked was 40 shares per unit; the old code multiplied by 100, so it showed 2.5 times the true volume). For those old-format answers only, which is better practice? A: keep showing the old scaled number (known to be wrong by about 2.5x) until the upgrade finishes. B: mark the volume as missing (no number) for those answers, and make every calculation treat missing volume as missing, not as zero. C: have the service send both formats so old readers get a corrected number. Prices are correct in all three cases.
```

Answer:

```text
Choice: B

- **Missing data stays missing.** A number you know is about 2.5x too high is worse than no number. It feeds VWAP, liquidity screens and volume factors without any warning. The only related principle in my sources is honest labeling of data quality: "All market data in the video is simulated" (src 2, *Quantitative Finance from Scratch, part 40: GJR GARCH*, 2026-11-03, https://www.instagram.com/reel/DfRnjfGRKH-/). It is not about volume handling.
- **Missing must not mean zero.** Zero volume looks like a real observation and skews averages and regressions. Calculations should skip or carry NaN instead. My retrieved sources don't cover this. It is general practice.
- **Why not C:** A "corrected" old-format number needs a known lot size, and here the lot size is unknown (40 was just one checked value). So C invents data. Rejecting it is my reasoning, not something my sources say.

Evidence limits: neither retrieved source covers market-data engineering. Archive coverage and missing transcript counts were not given.
```

## Record kb-quantstackai

Agent: QuantStackAI (NQ futures backtests of popular trading rules and indicators, prop-firm math, automated strategies; Instagram reels). Errors: none.

Question:

```text
A charting and research system reads daily bar volume from a broker data service. During a client upgrade, some answers may still arrive in an old format whose stock volume is in unknown lot sizes (one value we checked was 40 shares per unit; the old code multiplied by 100, so it showed 2.5 times the true volume). For those old-format answers only, which is better practice? A: keep showing the old scaled number (known to be wrong by about 2.5x) until the upgrade finishes. B: mark the volume as missing (no number) for those answers, and make every calculation treat missing volume as missing, not as zero. C: have the service send both formats so old readers get a corrected number. Prices are correct in all three cases.
```

Answer:

```text
(empty answer)
```

## Record sec1-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Review section 1 (Overview, Problem, Goals, Non-goals, Open questions, user journeys) of a design for upgrading a broker market-data client so Forex bars load and stock volume is reported in shares. Approve it, or say what must change before the technical plan is written. The section follows.

## Overview

The QuantVPS history service `vertex-history` serves read-only IBKR bars, ticks, depth, news and option chains to the Vertex web app and the research jobs. It uses the IBKR Python client `ibapi` 9.81.1 (API 157). This design moves it to `ibapi` 10.30.1 (API 187), the client that the stack's Nautilus trader container already runs. With 10.30.1, IBKR serves Forex (CASH, MIDPOINT) bars for EUR.USD and GBP.USD, and it sends stock volume in shares. All readers of the bars change with it, so that every page shows volume in shares, and no page shows a number that is known to be wrong.

## The Problem

1. **Forex bars fail.** IBKR refuses EUR.USD and GBP.USD bars from a client below API 163 (error 10285, "upgrade to a minimum version 163"). Measured 2026-11-20 with the live gateway: 0 bars with 9.81.1, 22 daily bars each with 10.30.1. The Charts Forex picker (card vertex-fx-history) is blocked by this.
2. **US stock volume is wrong today, in two directions.** 9.81.1 sends US stock volume in lots whose size IBKR sets per stock (`mdSizeMultiplier`, 40 for SPY and AAPL on 2026-11-20).
   - The readers that merge IBKR with Yahoo (`packages/api/src/server/ibkr-history.ts`, `services/res … (section text shortened)
```

Answer:

```text
Decision: revise

My knowledge base does not cover IBKR `ibapi` versions or volume units. The two sources found for this question (ig-Dcdx_7pIuoD, 2026-08-25, and ig-DcGguB9oXDo, 2026-08-16) are about backtests and macro dashboards. So this review uses only general engineering practice.

Changes needed before the technical plan:

1. **Measurement dates:** The probes are dated 2026-11-20, which is after today (2026-11-19). Fix the dates or re-run the probes.
2. **G1 scope:** USD.JPY is a goal, but the probe only measured EUR.USD and GBP.USD. Measure USD.JPY or remove it from G1.
3. **G6 Forex claim:** G6 says Forex bars stay the same as with 9.81.1, but 9.81.1 returned 0 Forex bars. There is nothing to compare. Remove Forex from G6.
4. **Rollback (CUJ 3):** Restoring the old code brings back the ×100 readers, which show wrong volume. That contradicts "never a wrong one." Either roll back only the service, with readers that already show null when the unit is unknown, or say what readers show after rollback.
5. **G3 decision owner:** Name the person who made decision B. Knowledge bases don't own decisions, and mine has no evidence for it.
6. **Depth (Q1):** Depth sizes are in scope today but unchecked. Until checked, show depth size as unknown instead of reporting `sizeMultiplier` 1.
7. **Gateway support end (Q2):** Gateway support ends 2026-12-15. List it as a risk with a deadline and owner for the re-check, not just an open question.

The rest is sound: the volume ratios check out (2.5×, 40×, 0.69×), and the non-goals and G4 are clear.
```

## Record sec1-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Review section 1 (Overview, Problem, Goals, Non-goals, Open questions, user journeys) of a design for upgrading a broker market-data client so Forex bars load and stock volume is reported in shares. Approve it, or say what must change before the technical plan is written. The section follows.

## Overview

The QuantVPS history service `vertex-history` serves read-only IBKR bars, ticks, depth, news and option chains to the Vertex web app and the research jobs. It uses the IBKR Python client `ibapi` 9.81.1 (API 157). This design moves it to `ibapi` 10.30.1 (API 187), the client that the stack's Nautilus trader container already runs. With 10.30.1, IBKR serves Forex (CASH, MIDPOINT) bars for EUR.USD and GBP.USD, and it sends stock volume in shares. All readers of the bars change with it, so that every page shows volume in shares, and no page shows a number that is known to be wrong.

## The Problem

1. **Forex bars fail.** IBKR refuses EUR.USD and GBP.USD bars from a client below API 163 (error 10285, "upgrade to a minimum version 163"). Measured 2026-11-20 with the live gateway: 0 bars with 9.81.1, 22 daily bars each with 10.30.1. The Charts Forex picker (card vertex-fx-history) is blocked by this.
2. **US stock volume is wrong today, in two directions.** 9.81.1 sends US stock volume in lots whose size IBKR sets per stock (`mdSizeMultiplier`, 40 for SPY and AAPL on 2026-11-20).
   - The readers that merge IBKR with Yahoo (`packages/api/src/server/ibkr-history.ts`, `services/res … (section text shortened)
```

Answer:

```text
**Decision: revise**

My knowledge base doesn't cover this. The only sources found are risk-parity material (Part 42, `DfZSXlgxRCt`, 2026-11-06), which has nothing to do with this design. This review is based on general practice only.

**Changes needed:**

1. **Dates:** The measurements are dated 2026-11-20, which is after today (2026-11-19). Fix the dates or re-run the measurements.
2. **G1:** USD.JPY is a goal, but the probe measured only EUR.USD and GBP.USD. Measure USD.JPY, or drop it from G1.
3. **G6:** It says Forex bars "stay the same as with 9.81.1," but 9.81.1 returns 0 Forex bars. Limit G6 to futures, index and trade ticks.
4. **Rollback (G5/CUJ 3):** Rolling back restores the old code, including the ×100 readers, so wrong volume comes back. CUJ 3 says the opposite: "no volume, never a wrong one." Either keep the unit-aware readers through a rollback, or state the real behavior.
5. **G3:** The owner decision is credited to "two quant knowledge bases." A knowledge base can't make owner decisions. Name the human owner who decided.
6. **Scope:** Problem 1 says the Charts Forex picker is blocked, but the picker is a non-goal. Say that this change unblocks the picker without delivering it.
7. **Q1:** Depth sizes become `sizeMultiplier` 1 without being checked. Either show no depth size until it's verified, or make the check a gate before rollout.
8. **Q2:** The gateway loses support on 2026-12-15. Add the re-check after that upgrade as a tracked task.
```

## Record sec1r2-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Second review of section 1 of a design for upgrading a broker market-data client (Forex bars load, stock volume in shares). Your earlier changes were applied: UTC dates explained, USD.JPY measured on both clients, G6 limited to futures/index/ticks, service-only rollback with unit-aware readers, decision B credited to the owner, picker unblocked not delivered, depth check made a rollout gate, gateway deadline tracked as a follow-up card. Approve it, or say what must still change. The section follows.

# vertex-history: IBKR API client 10.30.1, Forex bars and one volume unit

* **Author:** Jeff Scott Ward
* **Date:** 2026-11-20 UTC (2026-11-19 evening, US Eastern time). All measurements are from 202
## Overview

The QuantVPS history service `vertex-history` serves read-only IBKR bars, ticks, depth, news and option chains to the Vertex web app and the research jobs. It uses the IBKR Python client `ibapi` 9.81.1 (API 157). This design moves it to `ibapi` 10.30.1 (API 187), the client that the stack's Nautilus trader container already runs. With 10.30.1, IBKR serves Forex (CASH, MIDPOINT) bars for EUR.USD and GBP.USD, and it sends stock volume in shares. All readers of the bars change with it, so that every page shows volume in shares, and no page shows a number that is known to be wrong.

## The Problem

1. **Forex bars fail.** IBKR refuses EUR.USD and GBP.USD bars from a client below API 163 (error 10285, "upgrade to a minimum version 163"). Measured 2026-11-20 UTC with the live … (section text shortened)
```

Answer:

```text
**Decision: revise**

My knowledge base doesn't cover this. The only relevant results are a reel on a US macro dashboard (`raw/ig-DcGguB9oXDo.md`, published 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/) and an undated archive README. Neither covers IBKR, `ibapi` or volume units. This review is my own reasoning and general engineering practice.

Your earlier changes are in, and they hold together. The numbers also check out: 132.3/52.9 ≈ 2.5, 52.9/1.32 ≈ 40, and 52.9/76.5 ≈ 0.69. Two things still need to change:

1. **Finish the Date line.** It stops at "All measurements are from 202". Complete it with the measurement date range and the gateway version (1048.1). Readers need it to trust every number in the section.
2. **Match G1 to what was measured.** G1 promises daily and hourly bars for EUR.USD and GBP.USD, and says USD.JPY "keeps loading". Only the EUR.USD hourly load (29 bars) was measured. Either measure GBP.USD and USD.JPY hourly bars on both clients, or say that hourly support is measured for EUR.USD only and the rest is a rollout check.

Optional: in G5, say "service only", as CUJ 3 does. "One step restores the old client and code" could be read as rolling back the readers too.

Once those two fixes are in, I'd approve it.
```

## Record sec1r2-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Second review of section 1 of a design for upgrading a broker market-data client (Forex bars load, stock volume in shares). Your earlier changes were applied: UTC dates explained, USD.JPY measured on both clients, G6 limited to futures/index/ticks, service-only rollback with unit-aware readers, decision B credited to the owner, picker unblocked not delivered, depth check made a rollout gate, gateway deadline tracked as a follow-up card. Approve it, or say what must still change. The section follows.

# vertex-history: IBKR API client 10.30.1, Forex bars and one volume unit

* **Author:** Jeff Scott Ward
* **Date:** 2026-11-20 UTC (2026-11-19 evening, US Eastern time). All measurements are from 202
## Overview

The QuantVPS history service `vertex-history` serves read-only IBKR bars, ticks, depth, news and option chains to the Vertex web app and the research jobs. It uses the IBKR Python client `ibapi` 9.81.1 (API 157). This design moves it to `ibapi` 10.30.1 (API 187), the client that the stack's Nautilus trader container already runs. With 10.30.1, IBKR serves Forex (CASH, MIDPOINT) bars for EUR.USD and GBP.USD, and it sends stock volume in shares. All readers of the bars change with it, so that every page shows volume in shares, and no page shows a number that is known to be wrong.

## The Problem

1. **Forex bars fail.** IBKR refuses EUR.USD and GBP.USD bars from a client below API 163 (error 10285, "upgrade to a minimum version 163"). Measured 2026-11-20 UTC with the live … (section text shortened)
```

Answer:

```text
**Decision: revise**

My knowledge base does not cover market-data engineering. The retrieved sources are about put-call parity, the Sharpe ratio, risk parity and the low-volatility anomaly ([Part 28](https://www.instagram.com/reel/DerWwTTiKGS/), 2026-10-19; `concepts.md`, date unknown). None of them covers volume units, IBKR clients or rollback. So this review is my own reasoning from general practice, not evidence from my sources. The archive notes do not report coverage or missing-transcript counts.

Your earlier changes are all in, and the section is close. These changes remain:

1. **Fix the cut-off sentence in the header.** "All measurements are from 202…" stops mid-sentence. Finish it with the exact UTC date, the live gateway version (1048.1) and the accounts or symbols probed.
2. **Make the G3 attribution checkable.** "Two quant knowledge bases answered B" should name each one and point to its dated record in `concepts_brief.md`. I can't confirm the other knowledge base's answer from here. This section is my only input.
3. **Say which source CUJ 2's pick list shows.** That path merges IBKR with Yahoo. Say whether it shows IBKR's 52.9 M or Yahoo's 76.5 M, and how the reader labels which source it used. Otherwise CUJ 2 looks like it conflicts with the 0.69× gap in the Non-Goals.
4. **Define a pass for the depth gate (Q1).** Name the symbol, what you compare against, and the tolerance that lets depth show a size unit.

Once these are done, I'd approve it.
```

## Record sec1r3-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 1 of a design for upgrading a broker market-data client (Forex bars load, stock volume in shares). Applied since round 2: header date line complete (it was cut only in the excerpt), G1 limited to measured daily bars with hourly bars as rollout checks, G5 says service-only rollback, decision B names each knowledge base and its record file, CUJ 2 says which source the pick list shows, and the depth gate has a pass rule. Approve it, or name what must still change. The section follows.

# vertex-history: IBKR API client 10.30.1, Forex bars and one volume unit

* **Author:** Jeff Scott Ward
* **Date:** 2026-11-20 UTC (2026-11-19 evening, US Eastern time). All measurements are from 2026-11-20 02:19-02:27 UTC.
* **Card:** vertex-history-api-163 (stack vertex)
* **Status:** draft. Section approvals: a knowledge-base expert decides (owner choice 2026-11-20, message (private message) in the job channel).
* **Predecessor:** [concepts_brief.md](concepts_brief.md) (brainstorm, 7 Goldfish reports in `goldfish/`)


## Overview

The QuantVPS history service `vertex-history` serves read-only IBKR bars, ticks, depth, news and option chains to the Vertex web app and the research jobs. It uses the IBKR Python client `ibapi` 9.81.1 (API 157). This design moves it to `ibapi` 10.30.1 (API 187), the client that the stack's Nautilus trader container already runs. With 10.30.1, IBKR serves Forex (CASH, MIDPOINT) bars for EUR.USD and GBP.USD, and it sends stock volume … (section text shortened)
```

Answer:

```text
**Decision: approve**

**Reasons:**
- **The round-2 fixes are in.** The header date line is complete. G1 counts only measured daily bars, and the hourly bars are rollout checks. G5 and CUJ 3 say the rollback covers the service only. CUJ 2 names the source tag shown in the pick list. Q1 has a concrete pass rule.
- **The numbers check out.** 1.32 M × 40 = 52.9 M. 132.3 M is 2.5 × 52.9 M. 52.9 / 76.5 = 0.69.
- **The rollback is safe.** G3 shows null volume when the unit is missing, so a service rollback can only show no volume. It cannot show a wrong number.

**Limits of my evidence:**
- My knowledge base doesn't cover IBKR `ibapi`, error 10285 or `mdSizeMultiplier`. The only relevant source I retrieved is a US macro dashboard reel ("The US economy in one dashboard", 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/). This approval is general engineering review, not something my sources back.
- I didn't retrieve `kb/kb-deepedgeintelligence.json`, so this run can't confirm the G3 claim that DeepEdge answered B. Check that file before you sign off.
- The archive overview says nobody checked the ASR transcripts against the audio (source kb-deepedgeintelligence-bdf2f65de8fa:README.md, date unknown). It also doesn't give coverage or missing-transcript counts.

**Optional (doesn't block approval):** in Q1, name the Technical Plan section that says who runs the depth check and what happens on a fail.
```

## Record sec1r3-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 1 of a design for upgrading a broker market-data client (Forex bars load, stock volume in shares). Applied since round 2: header date line complete (it was cut only in the excerpt), G1 limited to measured daily bars with hourly bars as rollout checks, G5 says service-only rollback, decision B names each knowledge base and its record file, CUJ 2 says which source the pick list shows, and the depth gate has a pass rule. Approve it, or name what must still change. The section follows.

# vertex-history: IBKR API client 10.30.1, Forex bars and one volume unit

* **Author:** Jeff Scott Ward
* **Date:** 2026-11-20 UTC (2026-11-19 evening, US Eastern time). All measurements are from 2026-11-20 02:19-02:27 UTC.
* **Card:** vertex-history-api-163 (stack vertex)
* **Status:** draft. Section approvals: a knowledge-base expert decides (owner choice 2026-11-20, message (private message) in the job channel).
* **Predecessor:** [concepts_brief.md](concepts_brief.md) (brainstorm, 7 Goldfish reports in `goldfish/`)


## Overview

The QuantVPS history service `vertex-history` serves read-only IBKR bars, ticks, depth, news and option chains to the Vertex web app and the research jobs. It uses the IBKR Python client `ibapi` 9.81.1 (API 157). This design moves it to `ibapi` 10.30.1 (API 187), the client that the stack's Nautilus trader container already runs. With 10.30.1, IBKR serves Forex (CASH, MIDPOINT) bars for EUR.USD and GBP.USD, and it sends stock volume … (section text shortened)
```

Answer:

```text
Decision: approve

My KB does not cover this. The retrieved sources are the QuantFinanceToGo concepts note (kb-quantfinancetogo-bdac178174f6:concepts.md, publication date unknown, no URL) and Part 31 on implied volatility (published 2026-10-24, https://www.instagram.com/reel/De4D23VCl2E/). They deal with option pricing, not IBKR client versions, volume units or rollout design. The structured index was also missing or out of date. So this review is my own reasoning.

Reasons:
- All six round-2 points are fixed. G1 is limited to measured daily bars, G5 and CUJ 3 say the rollback covers the service only, G3 names each knowledge base and its record file, CUJ 2 names the source tag, and Q1 has a pass rule. All measurements carry a timestamp.
- G3 and G4 (null volume, never a guessed number) and the after-rollback behavior in CUJ 3 match how data engineering usually treats unknown units: fail closed.
- The non-goals state the gap with Yahoo (0.69×) openly.

Optional changes, not blocking:
1. In Q1, set a number for "in the range of the tick sizes", for example the median depth size is at least 1× the median tick size.
2. Q2 depends on an owner decision about the gateway. Add a fallback if that decision has not come by 2026-12-15.
```

## Record sec2-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Review section 2 (Technical Plan) of a design for upgrading a broker market-data client so Forex bars load and stock volume is in shares. Section 1 (goals: G1 Forex daily bars load, G2 volume in shares everywhere, G3 unknown unit gives no volume, G4 missing never becomes zero, G5 safe install and service-only rollback, G6 futures/index/ticks unchanged) is approved. Approve this section, or name what must change. The section follows.

## Technical Plan (Architecture)

### Decisions (author: knowledge-base experts, owner delegation 2026-11-20)

The owner asked that a knowledge-base expert decide technical choices outside his field. Each choice below went to QuantFinanceToGo and DeepEdge Intelligence as one neutral question; both gave the same answer each time. Records: `kb/D1-*.json` to `kb/D4-*.json`. Both state that their sources do not cover this subject and that they answer from general practice.

| # | Question | Decision |
|---|---|---|
| D1 | Client source | **PyPI wheel** `nautilus_ibapi-10.30.1-py3-none-any.whl`, pinned by URL and SHA-256 `2aa0df654de46b469962f504541c388a099486c3e9aa5edb55a40e849ca00ed8`; no file of the exec node is read |
| D2 | Install shape | **Release folders**: one folder per release with code and venv; symlinks switch; rollback points the symlinks back |
| D3 | Depth size unit | **New depth version** with an explicit size unit; sizes are stored only after the unit is confirmed |
| D4 | Readers | **One TypeScript parser** for the two web readers a … (section text shortened)
```

Answer:

```text
Decision: revise

My knowledge base does not cover this subject. The only source this run retrieved is about the NYSE tick index (`ig-Dey7tMKiMsO`, 2026-10-22, https://www.instagram.com/reel/Dey7tMKiMsO/). It has no evidence on ibapi, bar units or deployment. The points below come from general practice.

**Changes:**
1. **Decisions table authorship.** The table names me as a co-author of D1–D4 and B. It dates them 2026-11-20, which is after today. I can't confirm the `kb/D*.json` records, and I can't confirm another expert agreed. Name the owner or an engineer as the decision-maker, and keep this review out of the approval record.
2. **Service item 3 is wrong.** `volume_unit: "shares"` on every security type mislabels futures, which are in contracts. Index and Forex have no volume. This breaks G6 and goes against the point of G2 and G3. Set the unit per secType: `"shares"` for STK, `"contracts"` for FUT, and `null` for IND and CASH. Add each case to the shared fixture.
3. **Depth unit switch.** Today one environment flag sets the unit for every instrument. Scope it per secType, or confirm stocks only, so futures depth is never labeled shares.
4. **Rollback check.** Rolling back to `legacy-9.81.1` serves bars v1. Add a smoke check that v1 US stock volume shows as null in the readers.

The rest is sound: pinned wheel with tree-hash gate, version checks, one size helper, schema-keyed cache, readers deployed first, and automatic rollback.
```

## Record sec2-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Review section 2 (Technical Plan) of a design for upgrading a broker market-data client so Forex bars load and stock volume is in shares. Section 1 (goals: G1 Forex daily bars load, G2 volume in shares everywhere, G3 unknown unit gives no volume, G4 missing never becomes zero, G5 safe install and service-only rollback, G6 futures/index/ticks unchanged) is approved. Approve this section, or name what must change. The section follows.

## Technical Plan (Architecture)

### Decisions (author: knowledge-base experts, owner delegation 2026-11-20)

The owner asked that a knowledge-base expert decide technical choices outside his field. Each choice below went to QuantFinanceToGo and DeepEdge Intelligence as one neutral question; both gave the same answer each time. Records: `kb/D1-*.json` to `kb/D4-*.json`. Both state that their sources do not cover this subject and that they answer from general practice.

| # | Question | Decision |
|---|---|---|
| D1 | Client source | **PyPI wheel** `nautilus_ibapi-10.30.1-py3-none-any.whl`, pinned by URL and SHA-256 `2aa0df654de46b469962f504541c388a099486c3e9aa5edb55a40e849ca00ed8`; no file of the exec node is read |
| D2 | Install shape | **Release folders**: one folder per release with code and venv; symlinks switch; rollback points the symlinks back |
| D3 | Depth size unit | **New depth version** with an explicit size unit; sizes are stored only after the unit is confirmed |
| D4 | Readers | **One TypeScript parser** for the two web readers a … (section text shortened)
```

Answer:

```text
**Decision: revise**

My sources do not cover broker clients, packaging or rollout. Most of this review is general practice. The only related source is the order-book note in **QuantFinanceToGo concepts** (`concepts.md`, Part 36, publication date unknown, no URL). It says depth determines slippage, which is why the depth unit is important.

**Required changes:**

1. **Fix the Bars v2 unit (item 3).** The plan sets `volume_unit: "shares"` for every security type, but futures volume is in contracts. That breaks G2 and G6. Set the unit by type: STK = `"shares"`, FUT = `"contracts"`, and IND/CASH = `null`, with volume null.
2. **Fix the dates.** Today is 2026-11-19, but the owner delegation and decision B are both dated 2026-11-20. Correct both dates or explain them.
3. **Make the owner the approver.** I cannot confirm what DeepEdge said or that the two of us agreed. I cannot verify `kb/D*.json`. The decision records say the experts answered from general practice, not from their sources. List the owner as the approver and the experts as advisers.
4. **Check D1's source.** `nautilus_ibapi` is a third-party repackaging, not IBKR's own release. Record where it came from and compare the `ibapi/` tree hash with IBKR's official 10.30.1 source before pinning it.
5. **Square tick drops with G6.** Dropping ticks that have a missing size changes the tick output. Either document this as an allowed exception to G6 or keep those ticks and mark them missing.

The other parts follow G3–G5: depth sizes are not stored while the unit is unknown, the cache key includes the schema, and rollback is automatic.
```

## Record sec2r2-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Second review of section 2 (Technical Plan). Applied: owner named as decision-maker with knowledge bases as advisers and the UTC/US-Eastern date explained; volume_unit set per security type (STK shares, FUT contracts, IND/CASH null); depth unit per type (futures contracts, stocks unknown until checked); a rollback check that readers show null v1 stock volume; the wheel provenance recorded against IBKR official archive hash; dropped ticks with missing size documented as the one G6 exception. Approve, or name what must still change. The section follows.

## Technical Plan (Architecture)

### Decisions (author: knowledge-base experts, owner delegation 2026-11-20)

Decision-maker: the owner, Jeff Scott Ward. On 2026-11-20 UTC (evening of 2026-11-19 US Eastern time) he delegated technical choices outside his field to a knowledge-base expert pick (job-channel messages (private message) and (private message)). The knowledge bases QuantFinanceToGo and DeepEdge Intelligence are advisers: each choice went to both as one neutral question, and both gave the same answer each time. Records: `kb/D1-*.json` to `kb/D4-*.json`. Both state that their sources do not cover this subject and that they answer from general practice.

| # | Question | Decision |
|---|---|---|
| D1 | Client source | **PyPI wheel** `nautilus_ibapi-10.30.1-py3-none-any.whl`, pinned by URL and SHA-256 `2aa0df654de46b469962f504541c388a099486c3e9aa5edb55a40e849ca00ed8`; no file of the exec node is read. Provenance: the  … (section text shortened)
```

Answer:

```text
Decision: revise

My sources don't cover this. The only retrieved items are the KB README (date unknown) and an unrelated reel, `ig-DbpuN8Rot-A`, "Markets with Nala…", dated 2026-08-05 (https://www.instagram.com/reel/DbpuN8Rot-A/). This review is based on general practice only.

All five fixes you listed are in the text. Four places still need to change:

1. **Data-flow diagram is out of date.** It still shows `volume_unit: "shares"` and depth `size_unit: "shares" | "unknown"`. Change it to the per-type values: bars `"shares"` / `"contracts"` / `null`, and depth `"contracts"` / `"shares"` / `"unknown"`. Also change its last line from "v2: volume as sent (shares)" to "v2: volume as sent, with `volume_unit`".
2. **No futures smoke check.** Installer step 4 only tests SPY and the two FX pairs. Add one FUT or CONTFUT daily-bars check that expects `volume_unit: "contracts"`. Otherwise the per-type branch is only covered by the fixture.
3. **Readers don't pass the unit through.** Say that the TypeScript and Python readers carry `volume_unit` into the web contract, and depth `size_unit` `"contracts"` and `"shares"` too, not only `"unknown"`. Say what v1 answers map to, for example `volume_unit` "unknown" or null.
4. **Dropped-tick counter has no alert.** `unsetSizes` exists, but nothing acts on it. Add a health warning when it is above zero, so the G6 exception is watched rather than only written down.

The rest is consistent: the cache key includes the schema, the rollback check expects v1 null volume, and the wheel provenance chain is recorded.
```

## Record sec2r2-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Second review of section 2 (Technical Plan). Applied: owner named as decision-maker with knowledge bases as advisers and the UTC/US-Eastern date explained; volume_unit set per security type (STK shares, FUT contracts, IND/CASH null); depth unit per type (futures contracts, stocks unknown until checked); a rollback check that readers show null v1 stock volume; the wheel provenance recorded against IBKR official archive hash; dropped ticks with missing size documented as the one G6 exception. Approve, or name what must still change. The section follows.

## Technical Plan (Architecture)

### Decisions (author: knowledge-base experts, owner delegation 2026-11-20)

Decision-maker: the owner, Jeff Scott Ward. On 2026-11-20 UTC (evening of 2026-11-19 US Eastern time) he delegated technical choices outside his field to a knowledge-base expert pick (job-channel messages (private message) and (private message)). The knowledge bases QuantFinanceToGo and DeepEdge Intelligence are advisers: each choice went to both as one neutral question, and both gave the same answer each time. Records: `kb/D1-*.json` to `kb/D4-*.json`. Both state that their sources do not cover this subject and that they answer from general practice.

| # | Question | Decision |
|---|---|---|
| D1 | Client source | **PyPI wheel** `nautilus_ibapi-10.30.1-py3-none-any.whl`, pinned by URL and SHA-256 `2aa0df654de46b469962f504541c388a099486c3e9aa5edb55a40e849ca00ed8`; no file of the exec node is read. Provenance: the  … (section text shortened)
```

Answer:

```text
Decision: revise

My knowledge base doesn't cover IBKR clients, packaging, schemas or deploys. The only sources retrieved this run were `concepts.md` (no date) and Part 28 (2026-10-19, https://www.instagram.com/reel/DerWwTTiKGS/), and neither is relevant. This review is based on general engineering practice only.

You applied all five changes correctly. Four things still need to change:

1. **Data flow diagram doesn't match the service text.**
   - The bars line shows only `volume_unit: "shares"`. Make it show the per-type values: STK `"shares"`, FUT/CONTFUT `"contracts"`, IND/CASH `null`.
   - The depth line shows `"shares" | "unknown"`. Add `"contracts"` for futures.
   - The reader caption "v2: volume as sent (shares)" should say "volume as sent, unit from `volume_unit`."

2. **IND/CASH volume differs between v1 and v2.** v2 sets it to null, but v1 readers pass it through "as sent." Either make v1 IND/CASH null too, or say why v1 is allowed to differ. Add a fixture case for this.

3. **Decisions heading.** "author: knowledge-base experts" goes against "Decision-maker: the owner." Change it to something like "recorded by: <author>; advisers: …"

4. **G6 exception is only measured on SPY.** The 226-of-226 result covers one symbol. Say that, and add an alert threshold on the dropped-tick and depth counters (`unsetSizes`) so the exception gets reviewed if it grows.
```

## Record sec2r3-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 2 (Technical Plan). Applied since round 2: data-flow diagram shows per-type units; a futures smoke check expecting contracts; readers pass volumeUnit and depth sizeUnit through to the web contract, with the v1 mapping stated (unit unknown, US stock null, IND/CASH null, futures as sent); a health warning when unset sizes occur, measured on SPY only; the decisions heading names the owner with advisers; D4 corrected because the research script cannot import the web package (re-asked, both advisers chose shared web parser plus a script twin plus shared sample answers). Approve, or name what must still change. The section follows.

## Technical Plan (Architecture)

### Decisions (decided by the owner through a knowledge-base pick; advisers QuantFinanceToGo and DeepEdge Intelligence)

Decision-maker: the owner, Jeff Scott Ward. On 2026-11-20 UTC (evening of 2026-11-19 US Eastern time) he delegated technical choices outside his field to a knowledge-base expert pick (job-channel messages (private message) and (private message)). The knowledge bases QuantFinanceToGo and DeepEdge Intelligence are advisers: each choice went to both as one neutral question, and both gave the same answer each time. Records: `kb/D1-*.json` to `kb/D4-*.json`. Both state that their sources do not cover this subject and that they answer from general practice.

| # | Question | Decision |
|---|---|---|
| D1 | Client source | **PyPI wheel** `nautilus_ibapi-10.30.1-py3-none-a … (section text shortened)
```

Answer:

```text
Decision: approve

My sources do not cover this subject. The retrieved evidence is the knowledge-base README (kb-deepedgeintelligence-bdf2f65de8fa:README.md, no publication date or URL) and one reel about Jackson Hole and the Fed (ig-Dcjc5I7ojQd, 2026-08-27, https://www.instagram.com/reel/Dcjc5I7ojQd/). Neither is about IBKR clients, size units or reader design. The structured index was not available and the passages did not cover every term, so I have no transcript counts to give. This review is based on general practice only.

The section now fixes every gap from round 2:
- **Units are explicit everywhere.** Bars v2 and depth v2 state their units by security type in the diagram, the service, the readers and the web contract (`volumeUnit`, `sizeUnit`).
- **The v1 mapping is stated in one place.** The diagram and the TypeScript and Python readers use the same rule.
- **Smoke checks cover each unit and rollback.** SPY must return "shares", ES CONTFUT must return "contracts", and after any rollback SPY is checked through the web reader.
- **The dropped-size exception is limited and visible.** The section says it was measured on SPY only, and health warns when it happens.
- **D4 is now workable.** The script twin plus shared sample answers keeps all three readers in step without the script importing the web package.
- **The decision record is clear.** The owner and the advisers are named.

Optional polish, not needed for approval:
- D1 still mentions the Nautilus container in the provenance line, but the installer no longer compares against it. Mark that line as a past check.
- Depth v2 `size_unit` for IND or CASH is not stated. Add "null" or state that these types have no depth.
```

## Record sec2r3-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 2 (Technical Plan). Applied since round 2: data-flow diagram shows per-type units; a futures smoke check expecting contracts; readers pass volumeUnit and depth sizeUnit through to the web contract, with the v1 mapping stated (unit unknown, US stock null, IND/CASH null, futures as sent); a health warning when unset sizes occur, measured on SPY only; the decisions heading names the owner with advisers; D4 corrected because the research script cannot import the web package (re-asked, both advisers chose shared web parser plus a script twin plus shared sample answers). Approve, or name what must still change. The section follows.

## Technical Plan (Architecture)

### Decisions (decided by the owner through a knowledge-base pick; advisers QuantFinanceToGo and DeepEdge Intelligence)

Decision-maker: the owner, Jeff Scott Ward. On 2026-11-20 UTC (evening of 2026-11-19 US Eastern time) he delegated technical choices outside his field to a knowledge-base expert pick (job-channel messages (private message) and (private message)). The knowledge bases QuantFinanceToGo and DeepEdge Intelligence are advisers: each choice went to both as one neutral question, and both gave the same answer each time. Records: `kb/D1-*.json` to `kb/D4-*.json`. Both state that their sources do not cover this subject and that they answer from general practice.

| # | Question | Decision |
|---|---|---|
| D1 | Client source | **PyPI wheel** `nautilus_ibapi-10.30.1-py3-none-a … (section text shortened)
```

Answer:

```text
**Decision: approve**

**Reasons:**
- All round-2 items are now in the section: per-type units in the data-flow diagram, the futures smoke check expecting "contracts", `volumeUnit` and `sizeUnit` passed through to the web contract, the v1 mapping, the `unset_sizes` health warning (noted as measured on SPY only), the decisions heading naming the owner and both advisers, and the corrected D4.
- Units are never guessed. Volume is null or "unknown" until the unit is confirmed, and the cache key includes the schema, so old v1 cache entries can't be served as v2.
- Installs and rollbacks have checks at every step: the pinned hash gate, tests run in the new release folder, smoke checks, an automatic rollback, and a check of v1 after any rollback.

**Optional wording fixes (not required for approval):**
1. The v1 reader rule names only "FUT". Write "FUT/CONTFUT" there so it matches the bars v2 rule.
2. Depth v2 `size_unit` covers only FUT and STK. Say what IND and CASH get (null, or depth not served).

**Evidence limits:** No source in my knowledge base covers this subject. The two passages found are a returns explainer (kb-quantfinancetogo-bdac178174f6:raw/ig-Dd1PeNiCtkl.md, "Quant Finance from scratch part 5: Measuring returns", 2026-09-28, https://www.instagram.com/reel/Dd1PeNiCtkl/) and an undated concepts index (kb-quantfinancetogo-bdac178174f6:concepts.md, no URL). Neither applies, so this review is based on general engineering practice. I don't have counts for archive coverage or missing transcripts.
```

## Record sec3-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Review section 3 (Alternatives Considered, Non-Functional Requirements, Future Improvements) of a design for upgrading a broker market-data client so Forex bars load and stock volume is in shares. Sections 1 (goals) and 2 (technical plan: client 10.30.1 from a pinned PyPI wheel, release folders with symlinks, bars v2 with volume_unit per security type, depth v2 with size unit, readers first, old answers show no stock volume) are approved. Approve this section, or name what must change. The section follows.

## Alternatives Considered

### Alternative A: Keep 9.81.1 and multiply by the real lot size

Read `mdSizeMultiplier` per stock and scale by it instead of 100. Rejected by the author: Forex still fails (error 10285 needs API 163), the lot size differs by stock and changes over time, and 9.81.1 rounds volume down to whole lots (SPY 1,323,464 x 40 = 52,938,560 against IBKR's 52,938,577).

### Alternative B: Get Forex bars through the Nautilus trader

The Nautilus container already runs 10.30.1. Rejected by the author: it is a live trading unit and out of scope; history reads must not add load or code to it.

### Alternative C: Temporary x100 for old (v1) answers

Readers keep today's x100 for v1 and use v2 as sent; a later change removes v1 support. Rejected by the owner (knowledge-base pick, 2026-11-20): it shows a number known to be 2.5 x too high during the deploy window and after any rollback.

### Alternative D: Readers ask for v2, the service also serves a corrected v1 … (section text shortened)
```

Answer:

```text
Decision: revise

**My sources don't cover this.** My knowledge base holds Instagram reel transcripts on macro and market topics, for example a Jackson Hole / Fed reel (`kb-deepedgeintelligence-bdf2f65de8fa:raw/ig-Dcjc5I7ojQd.md`, 2026-08-27, https://www.instagram.com/reel/Dcjc5I7ojQd/). Nothing in it covers ibapi, IBKR market-data client design or volume units. The review below is general engineering practice only.

**What must change:**

1. **Fix the dates on the owner decisions.** Alternatives C and D and the D4 re-check (Alternative I) are dated 2026-11-20, which is after today (2026-11-19). Give the real decision dates, or mark them as pending.
2. **Link each "knowledge-base pick" to its real record.** For C, D, F, G and H, give the decision ID, who decided, the date and a link. My knowledge base has none of these, so I can't confirm them.
3. **Add rollback to the requirements.** Say how long `legacy-9.81.1` is kept, and say that a rollback must also bring back the matching cache, or empty it.
4. **Give each Future Improvement an owner and a trigger.** In particular, the research data saved with the wrong volume needs a deadline. Until it is re-fetched or marked, it gives wrong numbers.

**Checks that pass:**
- 52,938,560 ÷ 40 = 1,323,464 exactly.
- 100 ÷ 40 = 2.5, which matches the "2.5 x too high" claim.

The reasons for rejecting each alternative are otherwise consistent.
```

## Record sec3-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Review section 3 (Alternatives Considered, Non-Functional Requirements, Future Improvements) of a design for upgrading a broker market-data client so Forex bars load and stock volume is in shares. Sections 1 (goals) and 2 (technical plan: client 10.30.1 from a pinned PyPI wheel, release folders with symlinks, bars v2 with volume_unit per security type, depth v2 with size unit, readers first, old answers show no stock volume) are approved. Approve this section, or name what must change. The section follows.

## Alternatives Considered

### Alternative A: Keep 9.81.1 and multiply by the real lot size

Read `mdSizeMultiplier` per stock and scale by it instead of 100. Rejected by the author: Forex still fails (error 10285 needs API 163), the lot size differs by stock and changes over time, and 9.81.1 rounds volume down to whole lots (SPY 1,323,464 x 40 = 52,938,560 against IBKR's 52,938,577).

### Alternative B: Get Forex bars through the Nautilus trader

The Nautilus container already runs 10.30.1. Rejected by the author: it is a live trading unit and out of scope; history reads must not add load or code to it.

### Alternative C: Temporary x100 for old (v1) answers

Readers keep today's x100 for v1 and use v2 as sent; a later change removes v1 support. Rejected by the owner (knowledge-base pick, 2026-11-20): it shows a number known to be 2.5 x too high during the deploy window and after any rollback.

### Alternative D: Readers ask for v2, the service also serves a corrected v1 … (section text shortened)
```

Answer:

```text
**Decision: revise**

My archive (QuantFinanceToGo reels on option pricing and volatility) has nothing on broker API clients, deploys or schema versioning. The two sources retrieved, part 38 (2026-11-01, reel DfNAhn7iHRa) and part 12 (2026-10-03, reel DeCw2yPRF6M), are off-topic. This review is based on general engineering practice only.

**Changes:**
1. **Fix the decision dates.** Alternatives C, D and I cite decisions dated 2026-11-20, which is tomorrow. Correct the dates or mark these decisions as pending. Also add dates to the D1–D3 picks (F, G, H).
2. **Alternative A:** the arithmetic is right (1,323,464 × 40 = 52,938,560). State the date and source of IBKR's reference figure 52,938,577 so the 17-share gap can be checked.
3. **Request rate:** the re-fetch card in Future Improvements will compete for the shared limit of about 6 requests per 120 s. Require it to use the same pacing and to run off-hours.
4. **Observability:** name the alert thresholds for `error10285`, `decodeErrors` and `unsetSizes`, and say who gets paged.
5. **Rollback:** say what the readers show if `legacy-9.81.1` is restored before its deletion date. This should match the approved rule that old answers show no stock volume.
6. **Future Improvements:** give the v1-removal card a trigger (the date `legacy-9.81.1` is deleted) and an owner.

Everything else here (the remaining alternatives, security, licence) looks consistent with the approved sections 1 and 2.
```

## Record sec3r2-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Second review of section 3 (Alternatives, Non-Functional Requirements, Future Improvements). Applied: all dates stated as UTC (2026-11-20 UTC is the evening of 2026-11-19 US Eastern, so they are not future dates) with links to each decision record; the source and date of the 52,938,577 figure; health warning thresholds and the missing pager filed as a follow-up card; rollback keep-time, cache emptying and reader behaviour; each future card has a trigger or deadline, an owner, and pacing rules for re-fetch. Approve, or name what must still change. The section follows.

## Alternatives Considered

All dates are UTC. 2026-11-20 UTC is the evening of 2026-11-19 in US Eastern time. Decision records: owner answers in the job channel (messages (private message) for the bridge, (private message) for the expert picks), adviser answers in `kb/` (bridge: `kb/kb-*.json`; D1-D3: `kb/D1-*.json` to `kb/D3-*.json`; D4: `kb/D4b-*.json`).

### Alternative A: Keep 9.81.1 and multiply by the real lot size

Read `mdSizeMultiplier` per stock and scale by it instead of 100. Rejected by the author: Forex still fails (error 10285 needs API 163), the lot size differs by stock and changes over time, and 9.81.1 rounds volume down to whole lots (SPY 2026-11-19 daily bar: 9.81.1 sends 1,323,464, x 40 = 52,938,560; 10.30.1 sends 52,938,577; both from the probe of 2026-11-20 02:19-02:27 UTC, `evidence/r981.json` and `evidence/r1030.json`).

### Alternative B: Get Forex bars through the Nautilus trader

 … (section text shortened)
```

Answer:

```text
**Decision: revise**

My knowledge base doesn't cover IB API, client upgrades or deploy design. The only related source is a macro dashboard reel ("The US economy in one dashboard", 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/). This review is based on general practice only.

The section is mostly sound, and the Alternative A arithmetic checks out (1,323,464 × 40 = 52,938,560). These changes are still needed:

1. **v1 removal after a rollback.** The trigger says "30 days without a rollback", but it doesn't say what happens if one occurs. State whether the 30-day clock restarts from the next switch.
2. **Health counters.** "Above 0 since start" resets on every restart, so a warning can disappear without being fixed. Persist the counters, or state that a reset clears the warning.
3. **Alert gap.** The alerts card has only a trigger. Give it a deadline, for example within 7 days of the switch. Until it ships, say who checks health by hand and how often.
4. **Rollback reader behaviour.** Name the signal readers use to apply rule G3, such as the schema or client version in the response. Also confirm that the cache is emptied before traffic returns, not after.
5. **Re-fetch pacing.** Old-data re-fetches share the ~6 requests / 120 s budget. Set a share or a cap so live readers are not starved.
6. **Owners.** "The job FIRSTMATE starts" isn't a named owner. Name a person or role who approves each card is done.
```

## Record sec3r2-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Second review of section 3 (Alternatives, Non-Functional Requirements, Future Improvements). Applied: all dates stated as UTC (2026-11-20 UTC is the evening of 2026-11-19 US Eastern, so they are not future dates) with links to each decision record; the source and date of the 52,938,577 figure; health warning thresholds and the missing pager filed as a follow-up card; rollback keep-time, cache emptying and reader behaviour; each future card has a trigger or deadline, an owner, and pacing rules for re-fetch. Approve, or name what must still change. The section follows.

## Alternatives Considered

All dates are UTC. 2026-11-20 UTC is the evening of 2026-11-19 in US Eastern time. Decision records: owner answers in the job channel (messages (private message) for the bridge, (private message) for the expert picks), adviser answers in `kb/` (bridge: `kb/kb-*.json`; D1-D3: `kb/D1-*.json` to `kb/D3-*.json`; D4: `kb/D4b-*.json`).

### Alternative A: Keep 9.81.1 and multiply by the real lot size

Read `mdSizeMultiplier` per stock and scale by it instead of 100. Rejected by the author: Forex still fails (error 10285 needs API 163), the lot size differs by stock and changes over time, and 9.81.1 rounds volume down to whole lots (SPY 2026-11-19 daily bar: 9.81.1 sends 1,323,464, x 40 = 52,938,560; 10.30.1 sends 52,938,577; both from the probe of 2026-11-20 02:19-02:27 UTC, `evidence/r981.json` and `evidence/r1030.json`).

### Alternative B: Get Forex bars through the Nautilus trader

 … (section text shortened)
```

Answer:

```text
**Decision: revise**

My knowledge base does not cover this. It covers quant concepts such as delta and log returns (`concepts.md`, date unknown) and the season-1 recap (`raw/ig-DeCw2yPRF6M.md`, 2026-10-03, https://www.instagram.com/reel/DeCw2yPRF6M/). It has nothing on IB API, deploys or observability, so everything below is general engineering practice.

**What checks out**
- The arithmetic holds: 1,323,464 × 40 = 52,938,560. The 17-share gap matches the whole-lot rounding.
- The "2.5× too high" claim is right: 100 ÷ 40 = 2.5.

**Changes still needed**
1. **Decision-record links.** `kb/D1-*.json` and the others are file patterns, not links. Give the exact file names, or a commit hash plus path.
2. **Times.** "After 16:00 ET" breaks the "all dates are UTC" rule. Add the UTC time, which shifts with daylight saving: 21:00 UTC in winter, 20:00 UTC in summer.
3. **Card owners.** "The job FIRSTMATE starts" is not an owner. Name a person or role who answers for each card.
4. **Health alerts card.** It has a trigger but no deadline. Add one, for example within 7 days of the switch, because the warnings have no pager until then.
5. **Health counters.** "Since start" resets when the service restarts, so a warning can disappear without being fixed. State whether the counters are kept across restarts or only cover the current run.
6. **Gateway re-check.** Name the client version to test against, and give a fallback if the Gateway upgrade slips past 2026-12-15.
```

## Record sec3r3-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 3 (Alternatives, Non-Functional Requirements, Future Improvements). Applied since round 2: exact record file names; ET times also in UTC; counters per run plus startedAt and journal lines kept across restarts; the alerts card has a 7-day deadline and a manual check until then; the schema field is the rollback signal and the cache is emptied before restart; a named owner accepts each card; re-fetch capped at 2 of 6 requests per 120 s; gateway re-check names the client and a fallback; v1-removal clock restarts after a rollback. Approve, or name what must still change. The section follows.

## Alternatives Considered

All dates are UTC. 2026-11-20 UTC is the evening of 2026-11-19 in US Eastern time. Decision records: owner answers in the job channel (messages (private message) for the bridge, (private message) for the expert picks). Adviser answers, in `kb/` beside this file: bridge `kb-quantfinancetogo.json`, `kb-deepedgeintelligence.json`, `kb-quantstackai.json` (empty); D1 `D1-kb-quantfinancetogo.json`, `D1-kb-deepedgeintelligence.json`; D2 `D2-kb-quantfinancetogo.json`, `D2-kb-deepedgeintelligence.json`; D3 `D3-kb-quantfinancetogo.json`, `D3-kb-deepedgeintelligence.json`; D4 `D4b-kb-quantfinancetogo.json`, `D4b-kb-deepedgeintelligence.json` (the first D4 files rest on a wrong premise). Times written as US Eastern (ET) are given in UTC too: 16:00 ET is 21:00 UTC until 2027-03-14 (daylight saving then makes it 20:00 UTC).

### Alternative A … (section text shortened)
```

Answer:

```text
Decision: approve

My knowledge base doesn't cover this design. The two passages I retrieved are the KB overview (source kb-deepedgeintelligence-bdf2f65de8fa:README.md, publication date and URL unknown) and one macro reel, "Jackson Hole Incoming…" (source kb-deepedgeintelligence-bdf2f65de8fa:raw/ig-Dcjc5I7ojQd.md, 2026-08-27, https://www.instagram.com/reel/Dcjc5I7ojQd/). Neither says anything about IB API versions, volume units, rollback or alerting. The archive build from 2026-10-23 holds 74 reels: 71 transcribed, 3 with no speech, 0 missing or deferred. The newest source retrieved for this query is from 2026-08-27. The structured index is stale, so it was left out. Everything below is general engineering practice, not KB evidence.

Reasons:
- Every round-2 point is now in the text: record file names, UTC times next to ET, counters with `startedAt` and journal lines that survive restarts, the 7-day alerts card with a manual check until then, the schema field as the rollback signal with the cache emptied first, a named owner for each card, the 2-of-6 re-fetch cap, the gateway re-check with a fallback, and the v1 clock restarting after a rollback.
- The rejected alternatives are each tied to a dated record, and D4b replaces the D4 files built on the wrong premise.

Optional changes (not needed for approval):
- The gateway re-check card names the client (10.30.1) but not who does the work. Say whether it is the FIRSTMATE job like the other cards.
- "Deadline 7 days after it" and "30 days after the switch" would be clearer if they counted from the switch's UTC timestamp as recorded in the receipt.
```

## Record sec3r3-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 3 (Alternatives, Non-Functional Requirements, Future Improvements). Applied since round 2: exact record file names; ET times also in UTC; counters per run plus startedAt and journal lines kept across restarts; the alerts card has a 7-day deadline and a manual check until then; the schema field is the rollback signal and the cache is emptied before restart; a named owner accepts each card; re-fetch capped at 2 of 6 requests per 120 s; gateway re-check names the client and a fallback; v1-removal clock restarts after a rollback. Approve, or name what must still change. The section follows.

## Alternatives Considered

All dates are UTC. 2026-11-20 UTC is the evening of 2026-11-19 in US Eastern time. Decision records: owner answers in the job channel (messages (private message) for the bridge, (private message) for the expert picks). Adviser answers, in `kb/` beside this file: bridge `kb-quantfinancetogo.json`, `kb-deepedgeintelligence.json`, `kb-quantstackai.json` (empty); D1 `D1-kb-quantfinancetogo.json`, `D1-kb-deepedgeintelligence.json`; D2 `D2-kb-quantfinancetogo.json`, `D2-kb-deepedgeintelligence.json`; D3 `D3-kb-quantfinancetogo.json`, `D3-kb-deepedgeintelligence.json`; D4 `D4b-kb-quantfinancetogo.json`, `D4b-kb-deepedgeintelligence.json` (the first D4 files rest on a wrong premise). Times written as US Eastern (ET) are given in UTC too: 16:00 ET is 21:00 UTC until 2027-03-14 (daylight saving then makes it 20:00 UTC).

### Alternative A … (section text shortened)
```

Answer:

```text
**Decision: approve**

All the round-2 changes you listed are now in the section:

- **Record file names.** All files are named exactly, and the reason for using D4b is stated.
- **Times.** Each ET time also has its UTC time, including the DST change on 2027-03-14 (that date is correct: it is the second Sunday of March 2027).
- **Observability.** The section covers run counters, `startedAt`, journal lines that survive restarts, the 7-day alerts deadline and the manual checks at the switch and 24 h later.
- **Rollback.** The `schema` field is the rollback signal, and the cache is emptied before the restart, so no stale request is served.
- **Cards.** A named owner accepts each card, re-fetch is capped at 2 of about 6 requests per 120 s, the gateway re-check names 10.30.1 and has a fallback report, and the v1-removal clock restarts after a rollback.

Two optional fixes, which do not block approval:
1. On the gateway card, state who decides if the upgrade is late. The fallback reports the risk but does not set a date.
2. Alternative A says "x 40" without explaining it. Add that 40 is SPY's `mdSizeMultiplier` on that date.

**Evidence limits:** My knowledge base has nothing on market-data engineering, IB API versions, deploys or rollback. The retrieved sources are about quant concepts: undated QuantFinanceToGo concepts notes (put-call parity, mean reversion, volatility targeting) and part 38 on the volatility smile (`raw/ig-DfNAhn7iHRa.md`, 2026-11-01, https://www.instagram.com/reel/DfNAhn7iHRa/). None of them supports or contradicts this design, so this review is based on general engineering practice only. The structured index was stale, and no missing or deferred transcript counts were provided to me.
```

## Record sec4-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Review section 4 (Detailed Implementation Plan and Verification Plan) of a design for upgrading a broker market-data client so Forex bars load and stock volume is in shares. Sections 1-3 are approved (client 10.30.1 from a pinned PyPI wheel; release folders with symlinks; bars v2 with volume_unit per security type; depth v2 with size unit, stocks unknown until a live check; readers deployed first; old answers show no stock volume; missing volume never becomes zero). Check that every needed file is listed with a reason and that the verification proves the goals. Approve, or name what must change. The section follows.

## Detailed Implementation Plan

One PR against `vertex/rebuild-darkfactory-20260921`, on top of PR #328 once that is merged (#328 changes the same service files and moves the service to 1.5.0). Commits stay small: shared fixture and parsers; readers; missing-volume fixes; service; installer; docs. No implementation code is in this document.

### Target Files to Create/Modify

#### Shared sample answers

1. `infra/quant-vps/history/fixtures/` (Create): JSON test fixtures (allowed by AGENTS.md rule 13: test fixtures). One file per case: bars v1 STK USD, bars v1 FUT, bars v1 IND, bars v2 STK (`volume_unit` "shares"), bars v2 CONTFUT ("contracts"), bars v2 CASH (null unit, null volume), depth v1 STK (`sizeMultiplier` 40), depth v2 STK "unknown", depth v2 STK "shares", depth v2 FUT "contracts", plus `expected.json` with the volume each reader must produce. Why: one s … (section text shortened)
```

Answer:

```text
Decision: revise

My knowledge base doesn't cover this design. It holds 74 Instagram reels, transcribed by machine and never checked against the audio. The newest one I retrieved is "Jackson Hole Incoming…" (2026-08-27, https://www.instagram.com/reel/Dcjc5I7ojQd/). It has nothing on IB API wiring. The README gives no publication date and no count of missing transcripts. Everything below is my own engineering review.

Changes needed:

1. **Fixtures:** Add v1 CASH (FX) and v1 CONTFUT fixtures, plus a v1 STK case in a currency other than USD. Without them, item 7's v1 rule is only partly tested.
2. **Shared fixture loading:** Items 3 and 25 should load the item-1 fixtures and `expected.json`, or explain why they don't. Item 3 is the producer side, so it should at least check its output against the v2 fixtures.
3. **Missing-volume readers:** Search all users of `.v`, `volume` and `?? 0`, and list each file with a reason (charts, indicators, CSV export). Today only items 19-21 are named, and nothing proves the list is complete.
4. **Test the rollback:** Test `rollback-history.sh` and the automatic switch back, using a forced smoke-check failure before deploy.
5. **Cache verification:** In acceptance, show that an old v1 cache entry is not served after the switch.
6. **Dependency on #328:** Name the step that rebases onto #328 and re-checks it. The 1.6.0 version and the tick-by-tick callbacks depend on it.
7. **Depth step 3:** State what happens if the depth check fails: the unit stays "unknown", and you record that.
8. **SPY ratio:** Give a reason for the 0.5-1.0 IBKR/Yahoo band, or use the 0.69 figure observed on 2026-11-19 with a tolerance.
```

## Record sec4-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Review section 4 (Detailed Implementation Plan and Verification Plan) of a design for upgrading a broker market-data client so Forex bars load and stock volume is in shares. Sections 1-3 are approved (client 10.30.1 from a pinned PyPI wheel; release folders with symlinks; bars v2 with volume_unit per security type; depth v2 with size unit, stocks unknown until a live check; readers deployed first; old answers show no stock volume; missing volume never becomes zero). Check that every needed file is listed with a reason and that the verification proves the goals. Approve, or name what must change. The section follows.

## Detailed Implementation Plan

One PR against `vertex/rebuild-darkfactory-20260921`, on top of PR #328 once that is merged (#328 changes the same service files and moves the service to 1.5.0). Commits stay small: shared fixture and parsers; readers; missing-volume fixes; service; installer; docs. No implementation code is in this document.

### Target Files to Create/Modify

#### Shared sample answers

1. `infra/quant-vps/history/fixtures/` (Create): JSON test fixtures (allowed by AGENTS.md rule 13: test fixtures). One file per case: bars v1 STK USD, bars v1 FUT, bars v1 IND, bars v2 STK (`volume_unit` "shares"), bars v2 CONTFUT ("contracts"), bars v2 CASH (null unit, null volume), depth v1 STK (`sizeMultiplier` 40), depth v2 STK "unknown", depth v2 STK "shares", depth v2 FUT "contracts", plus `expected.json` with the volume each reader must produce. Why: one s … (section text shortened)
```

Answer:

```text
Decision: revise

My knowledge base doesn't cover this. The QuantFinanceToGo sources I found are about quant concepts: delta hedging and diversification (concepts.md, date unknown, no URL) and the low-volatility anomaly (Part 28, 2026-10-19, https://www.instagram.com/reel/DerWwTTiKGS/). They say nothing about broker clients, schemas or deploys. Everything below is general engineering judgment, not sourced.

Changes I'd make:

1. **Rollback test:** Run `rollback-history.sh` once in staging and check that `legacy-9.81.1` serves v1 again with the cache emptied. Right now the plan only tests the automatic switch back.
2. **Cache in readers:** Check that v1 cached answers in the web, lens and research readers are not served after the switch. Only the service cache key is tested now.
3. **Zero vs null:** Add a check that a CASH bar keeps null volume all the way to output (CSV, JSON, charts) and never shows 0.
4. **Fixture parity:** Make all three suites (TypeScript, lens, Python) fail on any change to `expected.json`. Run them in CI, not only before the PR.
5. **Precision:** Test that a fractional `Decimal` volume isn't silently rounded.
6. **Depth "unknown":** Add a live test that `flow-collect` stores no book sizes before deploy step 3.
7. **Ratio bound:** Explain the 0.5–1.0 IBKR/Yahoo range, or pin it to the 0.69 value from 2026-11-19 with a set tolerance.
8. **Ownership:** Name who owns step 7 and the PR #328 rebase, and how they'll check it.
```

## Record sec4r2-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Second review of section 4 (Detailed Implementation and Verification). Applied: fixtures for v1 CASH, v1 CONTFUT, non-USD stocks (unit unknown, volume null) and fractional volume; producer and reader suites all load the fixtures and run in CI; a searched inventory of every place that turns missing volume into zero, with the Charts volume study added; reader caches named; PR #328 rebase step with owner; live rollback drill; acceptance checks for the v1 cache, CASH null volume end to end, no stock book sizes before the depth step; ratio band explained (IBKR 0.69 and 0.56 of consolidated, old bug 1.73); depth-fail path; owners for later steps. Approve, or name what must still change. The section follows.

## Detailed Implementation Plan

One PR against `vertex/rebuild-darkfactory-20260921`, on top of PR #328 once that is merged (#328 changes the same service files and moves the service to 1.5.0). Commits stay small: shared fixture and parsers; readers; missing-volume fixes; service; installer; docs. No implementation code is in this document.

### Target Files to Create/Modify

#### Shared sample answers

1. `infra/quant-vps/history/fixtures/` (Create): JSON test fixtures (allowed by AGENTS.md rule 13: test fixtures). One file per case: bars v1 STK USD, bars v1 STK in another currency (EUR), bars v1 FUT, bars v1 CONTFUT, bars v1 IND, bars v1 CASH, bars v2 STK USD (`volume_unit` "shares"), bars v2 STK EUR ("unknown": non-USD stock volume was not measured with 10.30.1), bars v2 CO … (section text shortened)
```

Answer:

```text
**Decision: revise** (small changes)

My knowledge base doesn't cover IBKR API versions, volume units or deploy practice. The only sources this query found were a macro-dashboard reel (`ig-DcGguB9oXDo`, "The US economy in one dashboard", 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/) and the KB README (date unknown, no URL). Neither is relevant, so everything below is my own review from general practice.

**Changes needed:**
1. **Date errors:** The inventory is dated 2026-11-20, which is after today (2026-11-19). The ratio example uses 2026-11-19 as a "closed day". Fix the inventory date. Base the ratio on a session that has actually closed.
2. **Missing fixtures:** Add bars v2 FUT and bars v2 IND, plus depth v1 FUT. Without these, `expected.json` doesn't check every security type in every version the readers accept.
3. **Reader caches:** The pick-lists and research-lenses caches expire only on their TTL, so old 0 volumes can still be served after deploy step 1. Either flush them on deploy, or start the acceptance checks only after the longest TTL has passed. State which.
4. **Ratio band:** 0.4–0.95 comes from one day and two symbols. Check SPY and AAPL across about five sessions. If any value falls outside the band, treat it as a finding to look into, not a pass/fail gate.
5. **Rollback drill:** Record the `flow-collect` book-size count during the legacy window, so the "no stock book sizes" check covers the rollback period too.

Everything else is ready: the fixture CI coverage, the #328 owner and wait rule, the depth-fail path and the step owners.
```

## Record sec4r2-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Second review of section 4 (Detailed Implementation and Verification). Applied: fixtures for v1 CASH, v1 CONTFUT, non-USD stocks (unit unknown, volume null) and fractional volume; producer and reader suites all load the fixtures and run in CI; a searched inventory of every place that turns missing volume into zero, with the Charts volume study added; reader caches named; PR #328 rebase step with owner; live rollback drill; acceptance checks for the v1 cache, CASH null volume end to end, no stock book sizes before the depth step; ratio band explained (IBKR 0.69 and 0.56 of consolidated, old bug 1.73); depth-fail path; owners for later steps. Approve, or name what must still change. The section follows.

## Detailed Implementation Plan

One PR against `vertex/rebuild-darkfactory-20260921`, on top of PR #328 once that is merged (#328 changes the same service files and moves the service to 1.5.0). Commits stay small: shared fixture and parsers; readers; missing-volume fixes; service; installer; docs. No implementation code is in this document.

### Target Files to Create/Modify

#### Shared sample answers

1. `infra/quant-vps/history/fixtures/` (Create): JSON test fixtures (allowed by AGENTS.md rule 13: test fixtures). One file per case: bars v1 STK USD, bars v1 STK in another currency (EUR), bars v1 FUT, bars v1 CONTFUT, bars v1 IND, bars v1 CASH, bars v2 STK USD (`volume_unit` "shares"), bars v2 STK EUR ("unknown": non-USD stock volume was not measured with 10.30.1), bars v2 CO … (section text shortened)
```

Answer:

```text
Decision: revise

My archive has nothing on IBKR data engineering, ibapi, schemas or deploy practice. The two retrieved reels cover delta hedging (source 1, 2026-10-26, https://www.instagram.com/reel/De9QTG2iGeJ/) and the low-volatility anomaly (source 2, 2026-10-19, https://www.instagram.com/reel/DerWwTTiKGS/). Neither applies to this plan, so everything below is my own reasoning from general practice. I have no archive coverage or transcript counts for this query.

Changes still needed:

1. **Ratio band rests on two data points.** SPY 0.69 and AAPL 0.56 come from one day, 2026-11-19. A low-volume day or a half-day session could fall outside 0.4–0.95. Show the ratio over about 20 closed days for 3+ symbols, or base the check on the median.
2. **Inventory misses some patterns.** Also search for `fillna(0)`, `nan_to_num`, `Number(x) || 0`, `+v` coercion and SQL `COALESCE(volume, 0)`. Add `scripts/` Python too, not only `.ts`.
3. **Fractional volume is untested downstream.** Item 20's `vwap` and quantlab's CSV writer need a fractional-volume case, not only the parsers.
4. **Rollback is missing a reader check.** After `rollback-history.sh`, confirm that readers and the lens day cache do not serve v2 values cached under the v1 key. Today the drill only checks Charts.
5. **Step 3 has no time limit.** Set a deadline for the depth read so "unknown" does not stay in place forever.

Everything else looks sound to me.
```

## Record sec4r3-kb-deepedgeintelligence

Agent: DeepEdge Intelligence (institutional market data, macro, earnings; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 4 (Detailed Implementation and Verification). All dates are UTC; 2026-11-20 UTC is the evening of 2026-11-19 US Eastern, and 2026-11-19 is a closed session. Applied since round 2: fixtures for v2 FUT, v2 IND and depth v1 FUT; inventory widened to fillna, nan_to_num and SQL COALESCE in TypeScript and Python (two more hits, both not from this service); acceptance starts at least 10 minutes after the switch so reader caches (10 min and 1 min) hold nothing older; fractional-volume cases for VWAP and the CSV writer; the rollback drill records book rows and checks both cache directions; the ratio gate is now "below 1" and the 20-session, 3-symbol ratio is a recorded finding; the depth step has a deadline. Approve, or name what must still change. The section follows.

## Detailed Implementation Plan

One PR against `vertex/rebuild-darkfactory-20260921`, on top of PR #328 once that is merged (#328 changes the same service files and moves the service to 1.5.0). Commits stay small: shared fixture and parsers; readers; missing-volume fixes; service; installer; docs. No implementation code is in this document.

### Target Files to Create/Modify

#### Shared sample answers

1. `infra/quant-vps/history/fixtures/` (Create): JSON test fixtures (allowed by AGENTS.md rule 13: test fixtures). One file per case: bars v1 STK USD, bars v1 STK in another currency (EUR), bars v1 FUT, bars v1 CONTFUT, bars v1 IND, bars v1 CASH, bars v2 STK USD (`volume_unit` "shares") … (section text shortened)
```

Answer:

```text
Decision: revise

**Reasons**

My knowledge base has nothing on this. The retrieval returned only two reels: a screener workflow (ig-DcPAQxkIjTx, 2026-08-19, https://www.instagram.com/reel/DcPAQxkIjTx/) and a US macro dashboard (ig-DcGguB9oXDo, 2026-08-16, https://www.instagram.com/reel/DcGguB9oXDo/). Neither covers IB API versions, cache design or deploy checks. Archive coverage and missing-transcript counts were not given to me. The structured index was stale, so it was excluded. Everything below is my own reasoning.

The round-2 fixes are in place. One gap is left: the plan now has three "switches" (forward, the rollback drill, forward again), but steps 4 and 5 still say "the switch" without saying which.

**Changes**

1. **Name the anchor time.** Record T = the time of the final forward switch, after the drill. The 10-minute cache wait in step 5 starts at T.
2. **Count book rows from T.** The "no new SPY book sizes" check must count from T, not the first switch. The drill window is expected to add v1 rows, which would wrongly fail the check. Record the drill-window count separately, as step 4 already does.
3. **Set an order for the drill rows.** Say whether downstream readers keep or drop the v1 rows stored during the drill, so the step 6 depth result isn't mixed with them.
4. **State the time zone rule.** "21:00 UTC" equals 16:00 ET only while US Eastern is on standard time (EST). Add one line saying this applies until DST resumes.

With these four edits I would approve.
```

## Record sec4r3-kb-quantfinancetogo

Agent: QuantFinanceToGo (quantitative finance concepts: option pricing, volatility models, portfolio theory; Instagram reels). Errors: none.

Question:

```text
Third and last review of section 4 (Detailed Implementation and Verification). All dates are UTC; 2026-11-20 UTC is the evening of 2026-11-19 US Eastern, and 2026-11-19 is a closed session. Applied since round 2: fixtures for v2 FUT, v2 IND and depth v1 FUT; inventory widened to fillna, nan_to_num and SQL COALESCE in TypeScript and Python (two more hits, both not from this service); acceptance starts at least 10 minutes after the switch so reader caches (10 min and 1 min) hold nothing older; fractional-volume cases for VWAP and the CSV writer; the rollback drill records book rows and checks both cache directions; the ratio gate is now "below 1" and the 20-session, 3-symbol ratio is a recorded finding; the depth step has a deadline. Approve, or name what must still change. The section follows.

## Detailed Implementation Plan

One PR against `vertex/rebuild-darkfactory-20260921`, on top of PR #328 once that is merged (#328 changes the same service files and moves the service to 1.5.0). Commits stay small: shared fixture and parsers; readers; missing-volume fixes; service; installer; docs. No implementation code is in this document.

### Target Files to Create/Modify

#### Shared sample answers

1. `infra/quant-vps/history/fixtures/` (Create): JSON test fixtures (allowed by AGENTS.md rule 13: test fixtures). One file per case: bars v1 STK USD, bars v1 STK in another currency (EUR), bars v1 FUT, bars v1 CONTFUT, bars v1 IND, bars v1 CASH, bars v2 STK USD (`volume_unit` "shares") … (section text shortened)
```

Answer:

```text
**Decision: revise**

My knowledge base doesn't cover this. The retrieved sources are about put-call parity, volatility targeting, delta (`concepts.md`, no date or URL) and GARCH (`raw/ig-DfPHPULRYE7.md`, 2026-11-02, instagram.com/reel/DfPHPULRYE7). None of them address service rollout or volume units. The archive's coverage and missing-transcript counts weren't supplied, so they are unknown. Everything below is my own reasoning from general practice.

The section is nearly ready. Three changes are still needed:

1. **Time anchor for acceptance.** The rollback drill switches back to v1 and then forward again. Step 5 should start at least 10 minutes after the **final forward switch**, not after the first one. Otherwise the reader caches can still hold values from the drill's v1 window.
2. **Book-row check in step 5.** "No new SPY book sizes since the switch" conflicts with the drill, which expects v1 rows. Count from the final forward switch. Keep the drill's rows separate in the receipt.
3. **Ratio gate.** The 0.69 and 0.56 baselines were measured under the old v1 setup, which the step-5 "before" figures show was mis-scaled. State that they get re-measured on v2. If "below 1" is kept as the only hard gate, also fail when the ratio is below 0.4, since a near-zero ratio would mean volume is being lost. Or give the reason why a low ratio shouldn't fail.

Everything else, including the fixtures, the inventory, the cache TTLs, the fractional-volume cases and the depth deadline, is resolved.
```
