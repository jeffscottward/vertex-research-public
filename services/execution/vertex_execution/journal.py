"""Single-process, single-account paper journal; no broker or cloud authority.

SQLite FULL/WAL commits event, reservations and projection outbox together. A
nonblocking OS lock excludes competing owners; every mutation also compares the
persisted epoch. Crash after dispatch marking is UNKNOWN, never retryable. The
lock lives for the connection lifetime and is not released by UI/model failure.
Deployment must supply a private local durable directory (not NFS/tmpfs).
"""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import stat
import threading
from typing import Any, Callable, Iterator

from .exact import add, decimal, subtract, units
from .ports import ContractAuthority, ExecutionError
from .portfolio_projection import validate_genesis

_ZERO_HASH = "0" * 64
_TERMINAL = {"filled", "cancelled", "rejected"}



def initial_state(account_alias: str, simulator_id: str, currency: str) -> dict[str, Any]:
    return {"accountAlias": account_alias, "environment": "paper", "simulatorId": simulator_id,
            "currency": currency, "ownerEpoch": "0", "pausedNewRisk": True,
            "pauseReasons": ["initial-reconciliation-required"], "reconciled": False,
            "observation": None, "cash": "0", "positions": {}, "orders": {},
            "unsettledCredits": {}, "unsettledPositions": {}, "fillLineage": {},
            "corporateActions": {},
            "optionObligations": {},
            "portfolioRevision": "0",
            "settlements": {}, "invalidQualifications": [], "liquidationRequests": []}


def reserved(state: dict[str, Any]) -> tuple[int, dict[str, int]]:
    cash = 0
    shares: dict[str, int] = {}
    for order in state["orders"].values():
        if order["reservationState"] == "released":
            continue
        cash += units(order["cashReserve"])
        for instrument, amount in order["shareReserve"].items():
            shares[instrument] = shares.get(instrument, 0) + units(amount)
    return cash, shares


def apply_event(state: dict[str, Any], event: dict[str, Any]) -> None:
    """Strict replay reducer. A corrupt or unsupported transition stops startup."""
    kind, data = event["kind"], event["data"]
    if kind in {"observation", "reserve", "paper-event", "finalized", "abandon-reserved", "trade-settled", "settlement", "corporate-action"}:
        state["portfolioRevision"] = str(int(state["portfolioRevision"]) + 1)
    if kind == "epoch-claimed":
        if int(data["epoch"]) != int(state["ownerEpoch"]) + 1:
            raise ExecutionError("epoch-discontinuity")
        state["ownerEpoch"] = data["epoch"]
        state["pausedNewRisk"] = True
        state["reconciled"] = False
        state["pauseReasons"] = ["restart-reconciliation-required"]
        for order in state["orders"].values():
            if order["dispatchMarked"] and not order["finalityProven"]:
                order["status"] = "unknown"
    elif kind == "observation":
        previous = state["observation"]
        if previous and int(data["sourceSequence"]) <= int(previous["sourceSequence"]):
            raise ExecutionError("observation-sequence-regression")
        if previous is not None:
            # Observations reconcile owned balances, never replace authoritative
            # cash/positions or import opaque public portfolio projections.
            if data["cash"] != state["cash"] or data["positions"] != state["positions"]:
                raise ExecutionError("observation-ledger-disagreement")
        else:
            state["cash"], state["positions"] = data["cash"], data["positions"]
        state["observation"] = data
    elif kind == "reconciled":
        if state["observation"] is None or any(o["dispatchMarked"] and not o["finalityProven"] and (o["status"] == "unknown" or o["reconciledEpoch"] != state["ownerEpoch"]) for o in state["orders"].values()):
            raise ExecutionError("unresolved-reconciliation")
        state["reconciled"] = True
    elif kind == "portfolio-genesis":
        checkpoint = state.get("portfolioCheckpoint")
        if checkpoint and checkpoint["ownerEpoch"] == state["ownerEpoch"]:
            raise ExecutionError("duplicate-owner-epoch-genesis")
        state["portfolioCheckpoint"] = {**data, "portfolioRevision": state["portfolioRevision"]}
    elif kind == "portfolio-checkpoint":
        if data["ownerEpoch"] != state["ownerEpoch"]:
            raise ExecutionError("portfolio-checkpoint-stale-epoch")
        state["portfolioCheckpoint"] = {**data, "portfolioRevision": state["portfolioRevision"]}
    elif kind == "checkpoint-recorded":
        state["lastAuditCheckpoint"] = data
    elif kind == "reserve":
        key = data["submissionKey"]
        if key in state["orders"] or state["pausedNewRisk"] or not state["reconciled"]:
            raise ExecutionError("reservation-state-conflict")
        qualified = set(data.get("qualifiedKeys", [key]))
        if len(qualified) != len(data.get("qualifiedKeys", [key])) or not qualified:
            raise ExecutionError("duplicate-qualified-leg-identity")
        if any(qualified.intersection(o.get("qualifiedKeys", [k])) for k, o in state["orders"].items()):
            raise ExecutionError("qualified-leg-already-admitted")
        cash, shares = reserved(state)
        if units(data["cashReserve"]) < 0 or cash + units(data["cashReserve"]) > units(state["cash"]):
            raise ExecutionError("insufficient-unreserved-cash")
        for instrument, amount in data["shareReserve"].items():
            unsettled = sum(units(p["quantity"]) for p in state["unsettledPositions"].values() if p["instrumentId"] == instrument)
            if units(amount) < 0 or shares.get(instrument, 0) + units(amount) > units(state["positions"].get(instrument, "0")) - unsettled:
                raise ExecutionError("insufficient-unreserved-covered-shares")
        state["orders"][key] = deepcopy(data)
    elif kind in {"dispatch", "cancel-request", "paper-event", "finalized", "order-reconciled", "abandon-reserved"}:
        order = state["orders"].get(data["submissionKey"])
        if order is None or order["payloadSha256"] != data["payloadSha256"]:
            raise ExecutionError("order-payload-mismatch")
        if kind == "abandon-reserved":
            if order["dispatchMarked"] or order["fills"]:
                raise ExecutionError("cannot-abandon-possible-external-obligation")
            order["status"] = "rejected"
            order["cancelRequested"] = True
            order["finalityProven"] = True
            order["reservationState"] = "released"
            return
        if kind == "dispatch":
            if order["dispatchMarked"] or order["status"] != "not-submitted":
                raise ExecutionError("resubmission-forbidden")
            order["dispatchMarked"] = True
            order["status"] = "unknown"
        elif kind == "cancel-request":
            if not order["dispatchMarked"] or order["finalityProven"]:
                raise ExecutionError("cancel-state-conflict")
            order["cancelRequested"] = True
        elif kind == "order-reconciled":
            if data["status"] not in {"submitted", "partially-filled", "filled", "cancelled", "rejected"}:
                raise ExecutionError("unknown-acceptance-not-reconciled")
            totals = {instrument: leg["filled"] for instrument, leg in order["legs"].items()}
            if data["cumulativeFills"] != totals:
                raise ExecutionError("reconciliation-fill-disagreement")
            order["status"] = data["status"]
            order["reconciledEpoch"] = state["ownerEpoch"]
        elif kind == "paper-event":
            identifier = data["eventId"]
            previous = order["events"].get(identifier)
            if previous is not None:
                if previous != data:
                    raise ExecutionError("event-identity-payload-conflict")
                return
            if order["finalityProven"]:
                raise ExecutionError("event-after-proven-finality")
            if not order["dispatchMarked"]:
                raise ExecutionError("event-before-dispatch")
            order["events"][identifier] = data
            event_kind = data["eventKind"]
            if data.get("orderRef") is not None:
                if order["orderRef"] not in {None, data["orderRef"]}:
                    raise ExecutionError("order-reference-conflict")
                order["orderRef"] = data["orderRef"]
            if event_kind == "fill":
                fill_id = data["fillId"]
                if fill_id in order["fills"]:
                    old = order["fills"][fill_id]
                    comparable = {k: v for k, v in data.items() if k not in {"eventId", "occurredNs"}}
                    if old != comparable:
                        raise ExecutionError("fill-identity-payload-conflict")
                    return
                instrument = data["instrumentId"]
                leg = order["legs"].get(instrument)
                if leg is None or units(data["quantity"]) <= 0 or units(data["fee"]) < 0:
                    raise ExecutionError("invalid-fill")
                filled = add(leg["filled"], data["quantity"])
                if units(filled) > units(leg["maximumQuantity"]):
                    raise ExecutionError("fill-over-order-quantity")
                leg["filled"] = filled
                order["fills"][fill_id] = {k: v for k, v in data.items() if k not in {"eventId", "occurredNs"}}
                pending_id = data["submissionKey"] + ":" + fill_id
                cash_delta = units(data["cashDelta"])
                if cash_delta > 0:
                    state["unsettledCredits"][pending_id] = data["cashDelta"]
                else:
                    state["cash"] = add(state["cash"], data["cashDelta"])
                state["cash"] = subtract(state["cash"], data["fee"])
                if units(state["cash"]) < 0:
                    raise ExecutionError("fill-exceeds-reserved-cash-capacity")
                delta = units(data["quantity"]) * (1 if leg["side"] == "buy" else -1)
                state["positions"][instrument] = decimal(units(state["positions"].get(instrument, "0")) + delta)
                if delta > 0:
                    state["unsettledPositions"][pending_id] = {"instrumentId": instrument, "quantity": decimal(delta)}
                state["fillLineage"][pending_id] = {"sourceEventId": identifier, "strategyArtifactId": order["strategyArtifactId"],
                                                   "instrumentId": instrument, "signedQuantity": decimal(delta),
                                                   "cashDelta": data["cashDelta"], "fee": data["fee"],
                                                   "occurredNs": data["occurredNs"], "settled": False}
                # Cancels remain nonfinal pending authoritative race reconciliation.
                order["status"] = "filled" if all(l["filled"] == l["maximumQuantity"] for l in order["legs"].values()) else "partially-filled"
            elif event_kind == "accepted":
                if not order["fills"]:
                    order["status"] = "submitted"
            elif event_kind in {"cancelled", "rejected"}:
                if event_kind == "rejected" and order["fills"]:
                    raise ExecutionError("reject-after-fill")
                order["status"] = event_kind
            elif event_kind == "unknown":
                order["status"] = "unknown"
            else:
                raise ExecutionError("unsupported-paper-event")
        else:
            if order["status"] not in _TERMINAL or set(data["finalEventIds"]) != set(order["events"]):
                raise ExecutionError("terminal-race-not-reconciled")
            order["finalityProven"] = True
            order["finalEvidenceSha256"] = data["evidenceSha256"]
            # Short obligations/physical delivery cannot be unlocked on fill.
            if not order["settlementRequired"] or not order["fills"]:
                order["reservationState"] = "released"
            else:
                order["reservationState"] = "settlement-held"
    elif kind == "pause":
        state["pausedNewRisk"] = True
        if data["reason"] not in state["pauseReasons"]:
            state["pauseReasons"].append(data["reason"])
    elif kind == "reset":
        if not state["reconciled"] or state["invalidQualifications"]:
            raise ExecutionError("reset-before-reconciliation")
        state["pausedNewRisk"] = False
        state["pauseReasons"] = []
    elif kind == "qualification-invalidated":
        instrument = data["instrumentId"]
        if instrument not in state["invalidQualifications"]:
            state["invalidQualifications"].append(instrument)
        state["pausedNewRisk"] = True
        state["reconciled"] = False
    elif kind == "qualification-restored":
        if data["instrumentId"] not in state["invalidQualifications"]:
            raise ExecutionError("qualification-not-invalidated")
        state["invalidQualifications"].remove(data["instrumentId"])
    elif kind == "corporate-action":
        old, new = data["oldInstrumentId"], data["newInstrumentId"]
        if data["actionId"] in state["corporateActions"] or old not in state["invalidQualifications"]:
            raise ExecutionError("corporate-action-not-pending")
        if any((old in o["legs"] or old in o["shareReserve"]) and o["reservationState"] != "released" for o in state["orders"].values()):
            raise ExecutionError("corporate-action-open-order-or-collateral")
        if any(p["instrumentId"] == old for p in state["unsettledPositions"].values()):
            raise ExecutionError("corporate-action-unsettled-position")
        current = state["positions"].get(old, "0")
        numerator, denominator = int(data["quantityNumerator"]), int(data["quantityDenominator"])
        if numerator <= 0 or denominator <= 0 or units(current) * numerator % denominator:
            raise ExecutionError("corporate-action-inexact-quantity")
        if current != data["previousQuantity"]:
            raise ExecutionError("corporate-action-position-conflict")
        transformed = decimal(units(current) * numerator // denominator)
        state["positions"][old] = "0"
        state["positions"][new] = add(state["positions"].get(new, "0"), transformed)
        state["cash"] = add(state["cash"], data["cashDelta"])
        state["corporateActions"][data["actionId"]] = {**data, "newQuantity": transformed}
        state["pausedNewRisk"] = True
        state["reconciled"] = False
    elif kind == "trade-settled":
        for pending_id in data["fillKeys"]:
            lineage = state["fillLineage"].get(pending_id)
            if lineage is None or lineage["settled"]:
                raise ExecutionError("unknown-or-duplicate-trade-settlement")
            state["cash"] = add(state["cash"], state["unsettledCredits"].pop(pending_id, "0"))
            state["unsettledPositions"].pop(pending_id, None)
            lineage["settled"] = True
            lineage["settlementEvidenceSha256"] = data["evidenceSha256"]
    elif kind == "option-obligation":
        order = state["orders"].get(data["submissionKey"])
        if not order or order["reservationState"] == "released":
            raise ExecutionError("option-obligation-without-retained-collateral")
        state["optionObligations"][data["obligationId"]] = data
        state["pausedNewRisk"] = True
        state["reconciled"] = False
    elif kind == "settlement":
        if data["settlementId"] in state["settlements"]:
            raise ExecutionError("duplicate-settlement-transition")
        order = state["orders"].get(data["submissionKey"])
        if not order or not order["finalityProven"] or order["reservationState"] != "settlement-held":
            raise ExecutionError("unqualified-settlement-state")
        state["cash"] = add(state["cash"], data["cashDelta"])
        for instrument, delta in data["positionDeltas"].items():
            state["positions"][instrument] = add(state["positions"].get(instrument, "0"), delta)
        order["reservationState"] = "released"
        state["settlements"][data["settlementId"]] = data
        for obligation_id, obligation in list(state["optionObligations"].items()):
            if obligation["submissionKey"] == data["submissionKey"]:
                del state["optionObligations"][obligation_id]
    elif kind == "liquidation-request":
        # Intent only. A separately reviewed, re-risked simulator admission is
        # required per closing order; this transition dispatches nothing.
        state["liquidationRequests"].append(data)
        state["pausedNewRisk"] = True
    else:
        raise ExecutionError("unsupported-journal-event")


class Journal:
    def __init__(self, path: Path, *, authority: ContractAuthority, account_alias: str,
                 simulator_id: str, currency: str) -> None:
        self.authority = authority
        self.path = Path(path).absolute()
        self.mutex = threading.RLock()
        self.pid = os.getpid()
        self.poisoned = False
        self.connection: sqlite3.Connection | None = None
        self.lock_fd: int | None = None
        self.epoch = 0
        self.native_fact_factory: Callable[[dict[str, Any], dict[str, Any], int, str | None], tuple[tuple[dict[str, Any], bytes], ...]] | None = None
        parent = self.path.parent
        if parent.is_symlink() or not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) & 0o077:
            raise ExecutionError("private-local-journal-directory-required")
        if parent.resolve() != parent:
            raise ExecutionError("journal-path-symlink-forbidden")
        try:
            self.lock_fd = os.open(str(self.path) + ".owner", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            metadata = os.fstat(fd)
            os.close(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
                raise ExecutionError("unsafe-journal-file")
            self.connection = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False)
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY, event_id TEXT UNIQUE NOT NULL,
                    previous_hash TEXT NOT NULL, event_hash TEXT UNIQUE NOT NULL, payload BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS projections (
                    publication_sequence INTEGER PRIMARY KEY, owner_epoch TEXT NOT NULL,
                    sequence TEXT NOT NULL, event_hash TEXT NOT NULL,
                    payload BLOB NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
                    kind TEXT NOT NULL DEFAULT 'execution',
                    UNIQUE(owner_epoch, sequence, kind));
                CREATE TABLE IF NOT EXISTS native_proofs (
                    artifact_id TEXT PRIMARY KEY, sha256 TEXT UNIQUE NOT NULL, payload BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS native_fact_identities (
                    owner_epoch TEXT NOT NULL, journal_sequence TEXT NOT NULL,
                    journal_head_hash TEXT NOT NULL, fact_ordinal INTEGER NOT NULL CHECK(fact_ordinal BETWEEN 0 AND 63),
                    projection_hash TEXT UNIQUE NOT NULL,
                    PRIMARY KEY(owner_epoch, journal_sequence, journal_head_hash, fact_ordinal));
                CREATE TABLE IF NOT EXISTS checkpoints (
                    sequence INTEGER PRIMARY KEY, event_hash TEXT NOT NULL,
                    state_hash TEXT NOT NULL, payload BLOB NOT NULL);
            """)
            initial = initial_state(account_alias, simulator_id, currency)
            self.connection.execute("INSERT OR IGNORE INTO metadata VALUES ('scope', ?)", (authority.encode(initial).decode(),))
            self.connection.execute("INSERT OR IGNORE INTO metadata VALUES ('epoch', '0')")
            stored = json.loads(self.connection.execute("SELECT value FROM metadata WHERE key='scope'").fetchone()[0])
            if stored != initial:
                raise ExecutionError("journal-scope-mismatch")
            self._initial = initial
            self.state, self.sequence, self.event_hash = self._replay()
            self.epoch = int(self.connection.execute("SELECT value FROM metadata WHERE key='epoch'").fetchone()[0])
            if self.epoch != int(self.state["ownerEpoch"]):
                raise ExecutionError("journal-fence-corruption")
            directory_fd = os.open(parent, os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except BaseException:
            self.close()
            raise

    def _db(self) -> sqlite3.Connection:
        if self.connection is None or self.pid != os.getpid() or self.poisoned:
            raise ExecutionError("closed-forked-or-uncertain-owner")
        return self.connection

    def _replay(self) -> tuple[dict[str, Any], int, str]:
        state = deepcopy(self._initial)
        sequence, previous = 0, _ZERO_HASH
        checkpoints = {row[0]: row[1:] for row in self._db().execute("SELECT sequence,event_hash,state_hash,payload FROM checkpoints")}
        for number, event_id, predecessor, digest, encoded in self._db().execute("SELECT sequence,event_id,previous_hash,event_hash,payload FROM events ORDER BY sequence"):
            event = json.loads(encoded)
            if number != sequence + 1 or predecessor != previous or event["sequence"] != str(number) or event["eventId"] != event_id:
                raise ExecutionError("journal-chain-discontinuity")
            if self.authority.encode(event) != encoded or self.authority.digest(event) != digest or event["previousHash"] != predecessor:
                raise ExecutionError("journal-hash-corruption")
            apply_event(state, event)
            sequence, previous = number, digest
            if number in checkpoints:
                mark, state_hash, payload = checkpoints.pop(number)
                if mark != digest or self.authority.encode(state) != payload or self.authority.digest(state) != state_hash:
                    raise ExecutionError("checkpoint-state-corruption")
        if checkpoints:
            raise ExecutionError("checkpoint-ahead-of-journal")
        chains: dict[str, tuple[int, str]] = {}
        source_ordinals: dict[tuple[str, str, str], int] = {}
        latest_source_sequence: dict[str, int] = {}
        last_native_source: dict[str, tuple[str, str, str] | None] = {}
        for epoch, number, digest, encoded, kind in self._db().execute("SELECT owner_epoch,sequence,event_hash,payload,kind FROM projections ORDER BY publication_sequence"):
            projection = json.loads(encoded)
            prior_number, prior_hash = chains.get(epoch, (0, None))
            if kind == "portfolio-genesis":
                if prior_number != 0 or number != "1" or validate_genesis(self.authority, projection) != digest:
                    raise ExecutionError("genesis-outbox-chain-corruption")
            elif kind in {"execution", "native-fact"}:
                contract = "ExecutionProjection" if kind == "execution" else "NativeFactProjection"
                if self.authority.validate(contract, projection) is not True:
                    raise ExecutionError("native-projection-validation-required")
                if projection["previousEventHash"] != prior_hash or projection["eventHash"] != digest:
                    raise ExecutionError("projection-outbox-chain-corruption")
                if kind == "native-fact":
                    proof_row = self._db().execute("SELECT payload FROM native_proofs WHERE artifact_id=? AND sha256=?",
                                                  (projection["proof"]["artifactId"], projection["proof"]["sha256"])).fetchone()
                    if proof_row is None:
                        raise ExecutionError("native-fact-proof-missing")
                    self.validate_fact_proof(projection, proof_row[0])
                    identity = (epoch, projection["proofJournalSequence"], projection["proofJournalHeadHash"])
                    ordinal = source_ordinals.get(identity, 0)
                    if (projection["factOrdinal"] != ordinal or ordinal >= 64
                            or ordinal > 0 and last_native_source.get(epoch) != identity):
                        raise ExecutionError("native-fact-source-ordinal-discontinuity")
                    if (int(identity[1]) < latest_source_sequence.get(epoch, 0)
                            or identity not in source_ordinals and int(identity[1]) == latest_source_sequence.get(epoch, 0)):
                        raise ExecutionError("native-fact-source-sequence-regression")
                    source_ordinals[identity] = ordinal + 1
                    latest_source_sequence[epoch] = int(identity[1])
                    last_native_source[epoch] = identity
                    stored = self._db().execute("SELECT projection_hash FROM native_fact_identities WHERE owner_epoch=? AND journal_sequence=? AND journal_head_hash=? AND fact_ordinal=?",
                                                (*identity, ordinal)).fetchone()
                    if stored != (digest,):
                        raise ExecutionError("native-fact-source-identity-corruption")
            elif kind == "portfolio-snapshot":
                if self.authority.validate("PortfolioSnapshot", projection) is not True:
                    raise ExecutionError("native-portfolio-validation-required")
                if int(number) != prior_number or projection["sourceEventHash"] != prior_hash or digest != prior_hash:
                    raise ExecutionError("portfolio-snapshot-head-mismatch")
            else:
                raise ExecutionError("unsupported-outbox-kind")
            if kind != "native-fact":
                last_native_source[epoch] = None
            expected = prior_number if kind == "portfolio-snapshot" else prior_number + 1
            if int(number) != expected or projection["ownerEpoch"] != epoch or self.authority.encode(projection) != encoded:
                raise ExecutionError("noncanonical-projection-outbox")
            chains[epoch] = (int(number), digest)
        if self._db().execute("SELECT COUNT(*) FROM native_fact_identities").fetchone()[0] != sum(source_ordinals.values()):
            raise ExecutionError("native-fact-source-identity-corruption")
        return state, sequence, previous

    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self.mutex:
            db = self._db()
            db.execute("BEGIN IMMEDIATE")
            try:
                epoch = int(db.execute("SELECT value FROM metadata WHERE key='epoch'").fetchone()[0])
                if epoch != self.epoch:
                    raise ExecutionError("stale-owner-epoch")
                yield
                db.execute("COMMIT")
            except BaseException as error:
                try:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                except BaseException:
                    self.poisoned = True
                    raise
                if isinstance(error, sqlite3.Error):
                    self.poisoned = True
                raise

    def claim(self, *, now_ns: int) -> int:
        with self.mutex:
            new_epoch = self.epoch + 1
            self.append("epoch-claimed", {"epoch": str(new_epoch)}, now_ns=now_ns,
                        event_id=f"epoch-{new_epoch}", claim_epoch=new_epoch)
            return self.epoch

    def snapshot(self) -> tuple[dict[str, Any], int, str]:
        with self.mutex:
            return deepcopy(self.state), self.sequence, self.event_hash

    def append(self, kind: str, data: dict[str, Any], *, now_ns: int, event_id: str,
               expected_sequence: int | None = None, claim_epoch: int | None = None,
               projection: Callable[[dict[str, Any], int, str], dict[str, Any]] | None = None,
               projection_kind: str = "execution") -> tuple[int, str]:
        if type(now_ns) is not int or now_ns < 0:
            raise ExecutionError("exact-journal-clock-required")
        with self.mutex:
            with self.transaction():
                if expected_sequence is not None and self.sequence != expected_sequence:
                    raise ExecutionError("ledger-revision-conflict")
                prior = self._db().execute("SELECT sequence,event_hash,payload FROM events WHERE event_id=?", (event_id,)).fetchone()
                if prior:
                    old = json.loads(prior[2])
                    if old["kind"] != kind or old["data"] != data:
                        raise ExecutionError("journal-idempotency-conflict")
                    return prior[0], prior[1]
                number = self.sequence + 1
                event = {"sequence": str(number), "previousHash": self.event_hash,
                         "ownerEpoch": str(self.epoch), "eventId": event_id,
                         "occurredNs": str(now_ns), "kind": kind, "data": data}
                encoded = self.authority.encode(event)
                digest = self.authority.digest(event)
                candidate = deepcopy(self.state)
                apply_event(candidate, event)
                self._db().execute("INSERT INTO events VALUES (?,?,?,?,?)", (number, event_id, self.event_hash, digest, encoded))
                if claim_epoch is not None:
                    self._db().execute("UPDATE metadata SET value=? WHERE key='epoch'", (str(claim_epoch),))
                if kind == "reset":
                    self._db().execute("DELETE FROM metadata WHERE key='local_pause'")
                if projection:
                    value = projection(candidate, number, digest)
                    if projection_kind == "portfolio-genesis":
                        projection_hash = validate_genesis(self.authority, value)
                    elif projection_kind == "execution":
                        if self.authority.validate("ExecutionProjection", value) is not True:
                            raise ExecutionError("native-projection-validation-required")
                        projection_hash = value["eventHash"]
                    elif projection_kind == "portfolio-snapshot":
                        if self.authority.validate("PortfolioSnapshot", value) is not True:
                            raise ExecutionError("native-portfolio-validation-required")
                        projection_hash = value["sourceEventHash"]
                        head_sequence, head_hash = self.projection_head()
                        if value["sequence"] != str(head_sequence) or projection_hash != head_hash:
                            raise ExecutionError("portfolio-snapshot-head-mismatch")
                    else:
                        raise ExecutionError("unsupported-outbox-kind")
                    self._db().execute("INSERT INTO projections(owner_epoch,sequence,event_hash,payload,kind) VALUES(?,?,?,?,?)",
                                       (value["ownerEpoch"], value["sequence"], projection_hash, self.authority.encode(value), projection_kind))
                if self.native_fact_factory is not None and projection is None:
                    head_sequence, head_hash = self.projection_head()
                    facts = self.native_fact_factory(candidate, event, head_sequence, head_hash)
                    if len(facts) > 64:
                        raise ExecutionError("native-fact-transition-bound")
                    for ordinal, (value, proof_bytes) in enumerate(facts):
                        if (self.authority.validate("NativeFactProjection", value) is not True
                                or value["sequence"] != str(head_sequence + 1) or value["previousEventHash"] != head_hash
                                or value["ownerEpoch"] != str(self.epoch)
                                or value["proofJournalSequence"] != str(number) or value["proofJournalHeadHash"] != digest
                                or value["factOrdinal"] != ordinal):
                            raise ExecutionError("native-fact-sequence-conflict")
                        self.validate_fact_proof(value, proof_bytes)
                        self._db().execute("INSERT OR IGNORE INTO native_proofs VALUES(?,?,?)",
                                           (value["proof"]["artifactId"], value["proof"]["sha256"], proof_bytes))
                        saved = self._db().execute("SELECT sha256,payload FROM native_proofs WHERE artifact_id=?", (value["proof"]["artifactId"],)).fetchone()
                        if saved != (value["proof"]["sha256"], proof_bytes):
                            raise ExecutionError("native-proof-immutable-conflict")
                        self._db().execute("INSERT INTO native_fact_identities VALUES(?,?,?,?,?)",
                                           (value["ownerEpoch"], str(number), digest, ordinal, value["eventHash"]))
                        self._db().execute("INSERT INTO projections(owner_epoch,sequence,event_hash,payload,kind) VALUES(?,?,?,?,?)",
                                           (value["ownerEpoch"], value["sequence"], value["eventHash"], self.authority.encode(value), "native-fact"))
                        head_sequence, head_hash = int(value["sequence"]), value["eventHash"]
            self.state, self.sequence, self.event_hash = candidate, number, digest
            if claim_epoch is not None:
                self.epoch = claim_epoch
            return number, digest

    def validate_fact_proof(self, projection: dict[str, Any], encoded: bytes) -> None:
        # Public shape/hash/pair semantics belong to the source-bound authority.
        # This owner additionally proves the declared source is ITS durable event.
        validator = getattr(self.authority, "validate_native_journal_proof", None)
        if not callable(validator) or validator(projection, encoded, "1.0.0") is not True:
            raise ExecutionError("native-fact-proof-binding-mismatch")
        event_row = self._db().execute("SELECT event_id,event_hash,payload FROM events WHERE sequence=?",
                                      (int(projection["proofJournalSequence"]),)).fetchone()
        if event_row is None or event_row[:2] != (projection["proof"]["sourceEventId"], projection["proofJournalHeadHash"]):
            raise ExecutionError("native-proof-not-owned-journal-event")
        event = json.loads(event_row[2])
        genesis_row = self._db().execute("SELECT payload FROM projections WHERE owner_epoch=? AND kind='portfolio-genesis'",
                                        (projection["ownerEpoch"],)).fetchone()
        if (genesis_row is None or projection["accountAlias"] != self._initial["accountAlias"]
                or projection["environment"] != self._initial["environment"]
                or projection["streamId"] != json.loads(genesis_row[0])["streamId"]):
            raise ExecutionError("native-proof-owned-journal-scope-mismatch")
        if (event["ownerEpoch"] != projection["ownerEpoch"]
                or int(event["occurredNs"]) != self.authority.epoch_ns(projection["occurredAt"])):
            raise ExecutionError("native-proof-owned-event-scope-mismatch")

    def latch_pause(self, reason: str, *, now_ns: int) -> None:
        if type(now_ns) is not int or now_ns < 0:
            raise ExecutionError("exact-pause-clock-required")
        # Deliberately no public validator, model, gateway, outbox or network.
        # If subsequent fact generation fails this independently durable latch
        # still forbids admission; authorized reset clears it atomically.
        with self.transaction():
            self._db().execute("INSERT INTO metadata(key,value) VALUES('local_pause',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                               (json.dumps({"reason": reason, "occurredNs": str(now_ns)}, separators=(",", ":")),))

    def pause_latched(self) -> bool:
        with self.mutex:
            return self._db().execute("SELECT 1 FROM metadata WHERE key='local_pause'").fetchone() is not None

    def native_proof(self, projection: dict[str, Any]) -> bytes:
        with self.mutex:
            row = self._db().execute("SELECT payload FROM native_proofs WHERE artifact_id=? AND sha256=?",
                                    (projection["proof"]["artifactId"], projection["proof"]["sha256"])).fetchone()
            if row is None:
                raise ExecutionError("native-fact-proof-missing")
            self.validate_fact_proof(projection, row[0])
            return row[0]

    def projection_head(self) -> tuple[int, str | None]:
        row = self._db().execute("SELECT sequence,event_hash FROM projections WHERE owner_epoch=? ORDER BY publication_sequence DESC LIMIT 1", (str(self.epoch),)).fetchone()
        return (int(row[0]), row[1]) if row else (0, None)

    def next_projection(self) -> tuple[int, str, bytes] | None:
        with self.mutex:
            return self._db().execute("SELECT publication_sequence,event_hash,payload FROM projections WHERE acknowledged=0 ORDER BY publication_sequence LIMIT 1").fetchone()

    def next_projection_kind(self) -> str | None:
        with self.mutex:
            row = self._db().execute("SELECT kind FROM projections WHERE acknowledged=0 ORDER BY publication_sequence LIMIT 1").fetchone()
            return row[0] if row else None

    def acknowledge_projection(self, publication_sequence: int, digest: str) -> None:
        with self.transaction():
            head = self.next_projection()
            if head is None or head[0] != publication_sequence or head[1] != digest:
                raise ExecutionError("outbox-acknowledgment-order-conflict")
            self._db().execute("UPDATE projections SET acknowledged=1 WHERE publication_sequence=? AND event_hash=?", (publication_sequence, digest))

    def checkpoint(self) -> tuple[int, str]:
        with self.transaction():
            encoded = self.authority.encode(self.state)
            digest = self.authority.digest(self.state)
            self._db().execute("INSERT OR REPLACE INTO checkpoints VALUES (?,?,?,?)", (self.sequence, self.event_hash, digest, encoded))
            return self.sequence, digest

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None
