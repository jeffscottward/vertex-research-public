"""Migration 0059 stores run A of each qc-ports idea: the stored definitions must not drift from ideas.py."""
import json
import re
from pathlib import Path

import pytest

from strategies.qc_ports import data as qd
from strategies.qc_ports import ideas as qi

MIGRATION = Path(__file__).resolve().parents[3] / "packages" / "db" / "migrations" / "0059_qc_port_definitions.sql"
ROW = re.compile(
    r"\('qc-def-(qc-[a-z0-9-]+)-r1', '(qc-[a-z0-9-]+)', 1, '((?:[^']|'')+)', '((?:[^']|'')+)'::jsonb, "
    r"'([0-9a-f]{64})', '((?:[^']|'')+)', 'migration:0059'\)"
)
NOTE = re.compile(r"^Research run A of (qc-[a-z0-9-]+): from (\d{4}-\d{2}-\d{2}), capital 100000, "
                  r"data to (\d{4}-\d{2}-\d{2}) \(research_studies (qc-[a-z0-9-]+)\)$")
# StrategyDefinitionSchema defaults the TypeScript parser adds before the definition is stored.
SCHEMA_DEFAULTS = {"exit": {"any": []}, "sizing": {"mode": "allIn"}, "stopLoss": {"kind": "none"},
                   "takeProfit": {"kind": "none"}}


def _facts() -> qi.Facts:
    """Dummy facts: the definitions do not depend on the data, only the run start dates do."""
    starts = {idea: {symbol: "2010-01-29" for symbol in qi.CORE7} for idea in (
        "qc-asset-class-trend", "qc-futures-trend-carry", "qc-momentum-rotation", "qc-same-month-seasonality")}
    starts["qc-gold-fed-model"] = {"GLD": "2010-01-29"}
    starts["qc-oil-predicts-equity"] = {"SPY": "2011-05-31", "QQQ": "2011-05-31"}
    dates = {symbol: "2005-01-03" for symbol in qi.CORE7}
    return qi.Facts(iv_start=dates, iv_rank_join=dates, starts=starts, gold_last_input="2026-09-30")


def _stored() -> dict[str, dict]:
    rows = {}
    for idea, definition_id, name, definition, sha256, note in ROW.findall(MIGRATION.read_text(encoding="utf-8")):
        rows[idea] = {"definition_id": definition_id, "name": name.replace("''", "'"),
                      "definition": json.loads(definition.replace("''", "'")), "sha256": sha256,
                      "note": NOTE.match(note.replace("''", "'"))}
    return rows


def _normalized(definition) -> dict:
    return {**SCHEMA_DEFAULTS, **json.loads(json.dumps(definition))}


def test_migration_stores_run_a_of_every_idea_unchanged():
    stored = _stored()
    assert sorted(stored) == sorted(idea.id for idea in qi.IDEAS)
    runs = qi.family(_facts())
    for idea in qi.IDEAS:
        row = stored[idea.id]
        expected = _normalized(runs[idea.key("A")].definition)
        assert row["definition"] == expected, idea.id
        assert row["definition_id"] == idea.id
        assert row["name"] == expected["name"]
        assert row["note"] is not None and row["note"].group(1) == row["note"].group(4) == idea.id


@pytest.mark.skipif(not (qd.data_root() / "SHA256SUMS").exists(), reason="qc-ports data files not fetched")
def test_notes_name_the_research_run_start():
    from strategies.qc_ports import study

    runs = qi.family(study.load_study_data().facts)
    for idea_id, row in _stored().items():
        idea = next(item for item in qi.IDEAS if item.id == idea_id)
        assert row["note"].group(2) == runs[idea.key("A")].start, idea_id
