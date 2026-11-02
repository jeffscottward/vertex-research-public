"""Unexecuted synthetic wheel scenarios; no accounts or historical worksheet."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from strategies.wheel import (WheelContract, WheelEvent, WheelQuote, WheelSelectionPolicy,
                              WheelState, apply_event, early_exercise_review, obligations,
                              plan_roll, select_contracts)

D = Decimal
START = datetime(2026, 1, 2, 15, tzinfo=timezone.utc)
EXPIRY = START + timedelta(days=30)


def contract(right="put", expiry=EXPIRY, contract_id="SYNTH-P"):
    return WheelContract(contract_id, "SYNTH", right, D("100"), 100, expiry,
                         "test-calendar", "USD", "american", "physical")


def event(key, kind, at, option=None, *, contracts=1, price="0", confirmed=False, **kwargs):
    return WheelEvent(key, kind, at, "synthetic-source", "simulation", option, contracts,
                      D(price), D("0"), confirmed, **kwargs)


def short_put(contracts=1):
    return apply_event(WheelState("SYNTH", "USD"),
                       event("open", "open-put", START, contract(), contracts=contracts, price="2"))


def test_complete_cycle_put_assignment_shares_call_call_away():
    put = contract()
    state = short_put()
    assert state.stage == "short-put"
    assert obligations(state).cash_on_assignment == D("10000")
    assert state.net_cash_flow == D("200")
    state = apply_event(state, event("assign", "put-assignment", EXPIRY, put, confirmed=True))
    assert (state.shares, state.share_cost, state.stage) == (100, D("10000"), "shares")
    assert obligations(state).cash_on_assignment == D("0")
    call = contract("call", EXPIRY + timedelta(days=30), "SYNTH-C")
    state = apply_event(state, event("call", "open-call", EXPIRY + timedelta(days=1), call, price="3"))
    assert obligations(state).covered_shares == 100
    state = apply_event(state, event("away", "call-away", call.expiry_at, call, confirmed=True))
    assert (state.shares, state.share_cost, state.stage) == (0, D("0"), "cash")
    assert state.net_cash_flow == D("500")
    assert state.option_pnl == D("500")


def test_assignment_may_be_partial_and_event_replay_is_idempotent():
    state = short_put(2)
    partial = event("part", "put-assignment", EXPIRY, contract(), confirmed=True)
    state = apply_event(state, partial)
    assert state.shares == 100
    assert state.option.contracts == 1
    assert obligations(state).cash_on_assignment == D("10000")
    assert apply_event(state, partial) is state
    with pytest.raises(ValueError, match="changed content"):
        apply_event(state, replace(partial, contracts=2))


def test_expiry_requires_settlement_and_does_not_infer_from_price():
    state = short_put()
    with pytest.raises(ValueError, match="confirmed settlement"):
        apply_event(state, event("expire", "expiry", EXPIRY, contract()))
    with pytest.raises(ValueError):
        apply_event(state, event("expire", "expiry", START, contract(), confirmed=True))
    expired = apply_event(state, event("expire", "expiry", EXPIRY, contract(), confirmed=True))
    assert expired.stage == "cash"
    assert expired.option_pnl == D("200")


def test_covered_shares_and_existing_obligations_cannot_be_reused():
    with pytest.raises(ValueError, match="Existing obligation"):
        apply_event(short_put(), event("double", "open-put", START, contract()))
    with pytest.raises(ValueError, match="sufficient"):
        apply_event(WheelState("SYNTH", "USD"), event("naked", "open-call", START, contract("call")))
    with pytest.raises(ValueError):
        apply_event(WheelState("SYNTH", "USD"), event("cash", "open-put", START,
                    replace(contract(), settlement="cash")))
    with pytest.raises(ValueError):
        apply_event(WheelState("SYNTH", "USD"), event("same-day", "open-put", START,
                    replace(contract(), expiry_at=START + timedelta(hours=4))))


def test_dividend_uses_explicit_record_date_entitlement_even_after_call_away():
    state = WheelState("SYNTH", "USD")
    dividend = event("div", "dividend", START + timedelta(days=10), contracts=0,
                     price="1", confirmed=True, entitled_shares=100, entitlement_at=START)
    result = apply_event(state, dividend)
    assert result.shares == 0
    assert result.dividend_income == D("100")
    with pytest.raises(ValueError, match="entitlement"):
        apply_event(state, replace(dividend, entitlement_at=None))


def test_american_early_assignment_and_european_rejection():
    state = short_put()
    early = event("early", "put-assignment", START + timedelta(days=1), contract(), confirmed=True)
    assert apply_event(state, early).shares == 100
    european = replace(contract(), exercise_style="european")
    state = apply_event(WheelState("SYNTH", "USD"), event("euro", "open-put", START, european))
    with pytest.raises(ValueError, match="European"):
        apply_event(state, replace(early, contract=european))


def test_early_exercise_dividend_warning_is_not_a_probability_or_order():
    call = contract("call")
    state = apply_event(WheelState("SYNTH", "USD", 100, D("9000")),
                        event("call", "open-call", START, call, price="2"))
    result = early_exercise_review(state, as_of=START, underlying_price=D("105"),
                                  option_ask=D("5.1"), dividend_per_share=D("1"),
                                  ex_dividend_at=START + timedelta(days=1))
    assert "dividend-exceeds-extrinsic-review-before-ex-date" in result.reasons
    assert result.executable is False
    assert early_exercise_review(state, as_of=START, underlying_price=None,
                                 option_ask=None, dividend_per_share=None, ex_dividend_at=None).status == "unavailable"


def test_roll_requires_confirmed_close_before_replacement_and_full_obligation():
    state = short_put()
    replacement = contract(expiry=EXPIRY + timedelta(days=30), contract_id="NEXT-P")
    proposal = plan_roll(state, replacement, contracts=1, close_ask=D("3"), opening_bid=D("4"), as_of=START)
    assert proposal.close_cost == D("300")
    assert proposal.opening_credit == D("400")
    assert proposal.prospective_cash_obligation == D("10000")
    assert state.option.contract.contract_id == "SYNTH-P"
    assert proposal.executable is False
    closed = apply_event(state, event("close", "buy-close", START, contract(), price="3"))
    reopened = apply_event(closed, event("reopen", "open-put", START, replacement, price="4"))
    assert obligations(reopened).cash_on_assignment == D("10000")


def test_selection_retains_missing_data_and_conservative_collateral():
    state = WheelState("SYNTH", "USD")
    policy = WheelSelectionPolicy(14, 60, D("0.15"), 100, 50, 60)
    quote = WheelQuote(contract(), D("2"), D("2.1"), START, START, 100, 50, "source")
    selected = select_contracts(state, (quote,), as_of=START, policy=policy, available_cash=D("10000"))
    assert selected.candidates == (quote,)
    insufficient = select_contracts(state, (quote,), as_of=START, policy=policy, available_cash=D("9900"))
    assert "assignment-obligation-exceeds-supplied-cash" in insufficient.rejections[0][1]
    missing = select_contracts(state, (replace(quote, bid=None),), as_of=START, policy=policy, available_cash=None)
    assert "cash-readiness-unavailable" in missing.rejections[0][1]
    assert "missing-or-invalid-executable-quote" in missing.rejections[0][1]
    assert state.events == ()
