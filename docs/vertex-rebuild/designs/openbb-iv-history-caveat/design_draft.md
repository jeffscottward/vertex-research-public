# OpenBB IV History Caveat — Superseded EGM Draft

![Dark infographic showing unknown history, the proposed row-source design, and the unresolved audit method](openbb-iv-history-caveat.svg)

**Status:** This detailed draft is superseded by the [canonical EGM-resolved design](openbb-iv-history-caveat.md) and its [resolution report](review/goldfish_review_report.md). Do not use the former implementation rules below as requirements. The canonical design records the accepted fixes and current open gates.

The owner approved the Overview & Goals section and continuation on 2026-11-22. Full EGM review and resolution are complete. When this draft was superseded, the KB method and task identity boundary were unresolved; no query or implementation had started. Later, the owner approved the current OMP default and two origins, and the consultation returned no relevant source-backed guidance. The task decision and implementation are recorded in the canonical design and private method report.

The earlier draft included a date cutoff and timestamp rules based on aggregate run counts. Those rules are superseded. Run-level evidence does not prove an individual row's source or persistence. Use the canonical design for current requirements and stop conditions.
