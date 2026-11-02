"""Pure planning contracts; synthetic identities/budgets, never runtime admission."""
from dataclasses import FrozenInstanceError, fields, replace
from importlib import reload
from unittest import TestCase
from unittest.mock import patch

from agents import conversation
from agents.budget import BudgetLedger, usd_text, usd_units
from agents.conversation import ConversationPlan, ConversationTurn, compile_conversation
from agents.types import AgentFault, Budget, PHASES


TURN = Budget(60, "0.6", 10, "0.1", max_attempts=6, max_retries=1, max_tool_calls=2)
PARENT = Budget(540, "5.4", 10, "0.1", max_attempts=54, max_retries=1, max_tool_calls=18)
MEMBERS = tuple(f"expert-{index}" for index in range(1, 17))


def compile_plan(**changes):
    arguments = dict(mode="discuss", participant_ids=("expert-2", "expert-1"),
                     room_member_ids=MEMBERS, aggregate_budget=PARENT, turn_budget=TURN)
    arguments.update(changes)
    return compile_conversation(**arguments)


class ConversationPlannerTests(TestCase):
    def assert_fault(self, code, **changes):
        with self.assertRaises(AgentFault) as raised:
            compile_plan(**changes)
        self.assertEqual(raised.exception.code, code)

    def test_discussion_order_is_deterministic_and_never_adds_a_speaker(self):
        plan = compile_plan(room_member_ids=("first-mate", "expert-1", "expert-2"))
        self.assertEqual(plan, compile_plan(room_member_ids=("first-mate", "expert-1", "expert-2")))
        self.assertEqual(tuple(turn.participant_id for turn in plan.turns), ("expert-2", "expert-1"))
        self.assertEqual(tuple(turn.ordinal for turn in plan.turns), (1, 2))
        self.assertEqual(tuple(turn.coordination_id for turn in plan.turns), ("turn-1", "turn-2"))
        self.assertEqual(tuple(turn.round_index for turn in plan.turns), (1, 1))
        self.assertTrue(all(turn.kind == "statement" for turn in plan.turns))
        self.assertIsNone(plan.synthesizer_id)

    def test_discussion_accepts_exact_one_and_eight_and_rejects_outside_bounds(self):
        for count in (1, 8):
            with self.subTest(count=count):
                self.assertEqual(len(compile_plan(participant_ids=MEMBERS[:count]).turns), count)
        for count in (0, 9):
            with self.subTest(count=count):
                self.assert_fault("invalid-bound", participant_ids=MEMBERS[:count])

    def test_debate_accepts_exact_two_and_four_in_two_ordered_rounds(self):
        for selected in (("expert-2", "expert-1"), ("expert-4", "expert-2", "expert-1", "expert-3")):
            with self.subTest(selected=selected):
                plan = compile_plan(mode="debate", participant_ids=selected)
                self.assertEqual(tuple(turn.participant_id for turn in plan.turns), selected * 2)
                self.assertEqual(tuple(turn.round_index for turn in plan.turns),
                                 (1,) * len(selected) + (2,) * len(selected))
                self.assertTrue(all(turn.kind == "statement" for turn in plan.turns))
                self.assertEqual(tuple(turn.ordinal for turn in plan.turns), tuple(range(1, len(plan.turns) + 1)))
        for count in (0, 1, 5):
            with self.subTest(count=count):
                self.assert_fault("invalid-bound", mode="debate", participant_ids=MEMBERS[:count])

    def test_explicit_selected_synthesizer_adds_only_one_final_turn_up_to_nine(self):
        plan = compile_plan(mode="debate", participant_ids=MEMBERS[:4], synthesizer_id="expert-2")
        self.assertEqual(len(plan.turns), 9)
        self.assertEqual(plan.synthesizer_id, "expert-2")
        self.assertEqual(plan.turns[-1], ConversationTurn(9, "turn-9", "expert-2", None, "synthesis", TURN))
        self.assertEqual(sum(turn.kind == "synthesis" for turn in plan.turns), 1)
        self.assertEqual(len(compile_plan(mode="debate", participant_ids=MEMBERS[:4]).turns), 8)

    def test_discussion_synthesis_and_foreign_or_unselected_synthesizers_are_rejected(self):
        self.assert_fault("invalid-request", synthesizer_id="expert-1")
        for identity in ("foreign", "expert-3", "first-mate"):
            with self.subTest(identity=identity):
                self.assert_fault("invalid-request", mode="debate", synthesizer_id=identity)
        self.assert_fault("invalid-identity", mode="debate", synthesizer_id="")

    def test_duplicate_foreign_and_non_tuple_selections_are_rejected(self):
        for changes in (
            {"participant_ids": ("expert-1", "expert-1")},
            {"room_member_ids": ("expert-1", "expert-1")},
            {"participant_ids": ("foreign",)},
            {"participant_ids": ["expert-1"]},
            {"participant_ids": "expert-1"},
            {"room_member_ids": ["expert-1", "expert-2"]},
            {"room_member_ids": None},
        ):
            with self.subTest(changes=changes):
                self.assert_fault("invalid-request", **changes)

    def test_room_members_have_existing_one_to_sixteen_bound(self):
        self.assertEqual(compile_plan().room_member_ids, MEMBERS)
        for members in ((), MEMBERS + ("expert-17",)):
            with self.subTest(members=members):
                self.assert_fault("invalid-bound", room_member_ids=members)

    def test_identifiers_reuse_existing_exact_validation_without_normalizing(self):
        for value in (None, 1, True, "", " expert-1", "expert/1", "expert\n1", "é", "a" * 161, []):
            for field in ("participant_ids", "room_member_ids"):
                with self.subTest(field=field, value=value):
                    self.assert_fault("invalid-identity", **{field: (value,)})
        identity = "A" + "a_.:-0" * 26 + "123"
        self.assertEqual(len(identity), 160)
        plan = compile_plan(participant_ids=(identity,), room_member_ids=(identity,))
        self.assertEqual(plan.turns[0].participant_id, identity)

    def test_invalid_modes_are_rejected_without_coercion(self):
        for mode in (None, True, [], {}, "Debate", "execute", "discuss "):
            with self.subTest(mode=mode):
                self.assert_fault("invalid-request", mode=mode)

    def test_plan_and_turns_and_existing_budgets_are_immutable(self):
        plan = compile_plan()
        self.assertIsInstance(plan, ConversationPlan)
        self.assertIsInstance(plan.turns, tuple)
        for target, field, value in ((plan, "mode", "debate"), (plan.turns[0], "ordinal", 9),
                                     (plan.turns[0].budget, "tokens", 999)):
            with self.subTest(field=field), self.assertRaises(FrozenInstanceError):
                setattr(target, field, value)
        self.assertTrue(all(turn.budget is TURN for turn in plan.turns))
        self.assertIs(plan.aggregate_budget, PARENT)

    def test_exact_aggregate_ceilings_accept_and_each_one_unit_shortfall_rejects(self):
        exact = Budget(120, "1.2", 10, "0.1", max_attempts=12, max_retries=1, max_tool_calls=4)
        self.assertEqual(len(compile_plan(aggregate_budget=exact).turns), 2)
        for field, value in (("tokens", 119), ("usd", "1.199999999999999999"),
                             ("max_attempts", 11), ("max_tool_calls", 3)):
            with self.subTest(field=field):
                self.assert_fault("budget-exhausted", aggregate_budget=replace(exact, **{field: value}))

    def test_synthesis_budget_is_included_before_any_plan_is_returned(self):
        eight = replace(PARENT, tokens=TURN.tokens * 8, usd="4.8", max_attempts=48, max_tool_calls=16)
        self.assertEqual(len(compile_plan(mode="debate", participant_ids=MEMBERS[:4], aggregate_budget=eight).turns), 8)
        self.assert_fault("budget-exhausted", mode="debate", participant_ids=MEMBERS[:4],
                          synthesizer_id="expert-1", aggregate_budget=eight)

    def test_usd_uses_exact_fractional_and_large_integer_units(self):
        for child, attempt, total in (
            ("0.000000000000000003", "0.000000000000000001", "0.000000000000000006"),
            ("100000000000000000000000000000.000000000000000001", "1",
             "200000000000000000000000000000.000000000000000002"),
        ):
            with self.subTest(child=child):
                turn = replace(TURN, usd=child, attempt_usd=attempt)
                parent = replace(PARENT, usd=total, attempt_usd=attempt)
                plan = compile_plan(turn_budget=turn, aggregate_budget=parent)
                self.assertEqual(sum(usd_units(turn.budget.usd) for turn in plan.turns), usd_units(total))
                self.assert_fault("budget-exhausted", turn_budget=turn,
                                  aggregate_budget=replace(parent, usd=usd_text(usd_units(total) - 1)))
        largest = "999999999999999999999999999999"
        self.assert_fault("budget-exhausted", turn_budget=replace(TURN, usd=largest),
                          aggregate_budget=replace(PARENT, usd=largest))

    def test_stricter_parent_per_attempt_and_per_phase_retry_limits_reject(self):
        for field, value in (("attempt_tokens", 9), ("attempt_usd", "0.099999999999999999"),
                             ("max_retries", 0)):
            with self.subTest(field=field):
                self.assert_fault("budget-exhausted", aggregate_budget=replace(PARENT, **{field: value}))

    def test_retry_limit_is_per_phase_not_a_sum_or_a_promised_retry_allowance(self):
        # Three phases need three initial attempts. Eight retries PER PHASE are
        # a ceiling, not a promise: max_attempts=4 allows at most one extra here.
        turn = replace(TURN, tokens=40, usd="0.4", max_attempts=4, max_retries=8)
        parent = replace(PARENT, tokens=80, usd="0.8", max_attempts=8, max_retries=8)
        plan = compile_plan(turn_budget=turn, aggregate_budget=parent)
        self.assertEqual(tuple(t.budget.max_retries for t in plan.turns), (8, 8))
        self.assertEqual(sum(t.budget.max_attempts for t in plan.turns), 8)
        # A retry-free turn is valid; no implicit retry allowance is added.
        zero_retry = replace(turn, max_attempts=3, max_retries=0)
        self.assertEqual(compile_plan(turn_budget=zero_retry).turns[0].budget.max_retries, 0)

    def test_turn_needs_capacity_for_the_current_required_research_phase_sequence(self):
        self.assertEqual(PHASES, ("analyst", "counterpoint", "synthesis"))
        minimum = Budget(30, "0.3", 10, "0.1", max_attempts=3, max_retries=0, max_tool_calls=0)
        self.assertEqual(compile_plan(turn_budget=minimum).turns[0].budget, minimum)
        for field, value in (("tokens", 29), ("usd", "0.299999999999999999"), ("max_attempts", 2)):
            with self.subTest(field=field):
                self.assert_fault("budget-exhausted", turn_budget=replace(minimum, **{field: value}))

    def test_zero_usd_and_tool_budgets_are_valid_but_zero_token_capacity_is_not(self):
        turn = replace(TURN, usd="0", attempt_usd="0", max_tool_calls=0)
        parent = replace(PARENT, usd="0", attempt_usd="0", max_tool_calls=0)
        self.assertEqual(len(compile_plan(turn_budget=turn, aggregate_budget=parent).turns), 2)
        self.assert_fault("budget-exhausted", turn_budget=replace(turn, tokens=0), aggregate_budget=parent)
        self.assert_fault("invalid-bound", turn_budget=replace(turn, tokens=0, attempt_tokens=0))

    def test_both_budgets_reuse_all_ledger_validation(self):
        invalid = (
            ({"tokens": True}, "invalid-bound"), ({"tokens": -1}, "invalid-bound"),
            ({"tokens": 2**53}, "invalid-bound"), ({"attempt_tokens": 0}, "invalid-bound"),
            ({"attempt_tokens": True}, "invalid-bound"), ({"attempt_tokens": 2**53}, "invalid-bound"),
            ({"max_attempts": 0}, "invalid-bound"), ({"max_attempts": 65}, "invalid-bound"),
            ({"max_attempts": 3.0}, "invalid-bound"), ({"max_retries": -1}, "invalid-bound"),
            ({"max_retries": 9}, "invalid-bound"), ({"max_tool_calls": -1}, "invalid-bound"),
            ({"max_tool_calls": 65}, "invalid-bound"), ({"usd": 1.2}, "invalid-budget"),
            ({"usd": "0.60"}, "invalid-budget"), ({"usd": "1e2"}, "invalid-budget"),
            ({"usd": "-1"}, "invalid-budget"), ({"usd": "0.0000000000000000001"}, "invalid-budget"),
            ({"usd": "1000000000000000000000000000000"}, "invalid-budget"),
            ({"attempt_usd": "NaN"}, "invalid-budget"), ({"attempt_usd": 0}, "invalid-budget"),
            ({"attempt_tokens": 541}, "budget-exhausted"), ({"attempt_usd": "6"}, "budget-exhausted"),
        )
        for field, base in (("turn_budget", TURN), ("aggregate_budget", PARENT)):
            for changes, code in invalid:
                with self.subTest(field=field, changes=changes):
                    self.assert_fault(code, **{field: replace(base, **changes)})
            for value in (None, {}, "budget"):
                with self.subTest(field=field, value=value):
                    self.assert_fault("invalid-budget", **{field: value})

    def test_planning_neither_spends_nor_refills_an_existing_ledger(self):
        ledger = BudgetLedger(PARENT)
        ledger.reserve("existing-attempt", "analyst")
        ledger.settle("existing-attempt", None, "unknown-usage")
        before = (ledger.tokens, ledger.usd, ledger.attempt_count, ledger.tool_count, tuple(ledger.records))
        self.assertEqual(compile_plan(aggregate_budget=ledger.budget), compile_plan(aggregate_budget=ledger.budget))
        self.assertEqual(before, (ledger.tokens, ledger.usd, ledger.attempt_count, ledger.tool_count, tuple(ledger.records)))

    def test_import_and_compilation_do_not_execute_or_admit_work(self):
        from contextlib import ExitStack
        targets = (
            "agents.orchestrator.ResearchOrchestrator.run", "agents.evidence.EvidenceGate.admit",
            "agents.budget.BudgetLedger.reserve", "agents.budget.BudgetLedger.settle",
            "agents.budget.BudgetLedger.tool", "socket.socket", "subprocess.Popen", "os.system",
            "builtins.open",
        )
        with ExitStack() as stack:
            guards = [stack.enter_context(patch(target, side_effect=AssertionError("unexpected side effect")))
                      for target in targets]
            # Reload checks module initialization as well as the pure compiler.
            # Restore exported class identities for other tests after reloading.
            stack.enter_context(patch.dict(conversation.__dict__))
            module = reload(conversation)
            plan = module.compile_conversation(mode="debate", participant_ids=MEMBERS[:4],
                                               room_member_ids=MEMBERS, synthesizer_id="expert-1",
                                               aggregate_budget=PARENT, turn_budget=TURN)
            self.assertEqual(len(plan.turns), 9)
            for guard in guards:
                guard.assert_not_called()

    def test_inputs_and_records_expose_no_model_tool_prompt_or_admission_authority(self):
        for key in ("model", "allowed_tools", "prompt", "run_id", "job_id", "authorization", "admission"):
            with self.subTest(key=key), self.assertRaises(TypeError):
                compile_plan(**{key: "not-authority"})
        plan = compile_plan()
        forbidden = {"run_id", "job_id", "admitted", "available", "execution_authorized", "raw_reasoning"}
        for record in (plan, *plan.turns):
            self.assertFalse(forbidden.intersection(field.name for field in fields(record)))


class ChatConversationPlannerTests(TestCase):
    def arguments(self):
        return dict(mode="debate", participant_ids=("expert-2", "expert-1"),
                    room_member_ids=MEMBERS, synthesizer_id="expert-1",
                    execution_profile="vertex-research-chat-single-completion-v1",
                    turn_budget=Budget(1000, "0.2", 1000, "0.2", 1, 0, 0),
                    aggregate_budget=Budget(5000, "1", 1000, "0.2", 5, 0, 0))

    def test_explicit_chat_profile_allocates_exactly_five_single_completions(self):
        plan = compile_conversation(**self.arguments())
        self.assertEqual(tuple(t.participant_id for t in plan.turns),
                         ("expert-2", "expert-1", "expert-2", "expert-1", "expert-1"))
        self.assertEqual(tuple(t.kind for t in plan.turns),
                         ("statement", "statement", "statement", "statement", "synthesis"))
        self.assertEqual(tuple(t.round_index for t in plan.turns), (1, 1, 2, 2, None))
        self.assertTrue(all((t.budget.max_attempts, t.budget.max_retries, t.budget.max_tool_calls)
                            == (1, 0, 0) for t in plan.turns))

    def test_chat_profile_never_changes_default_three_phase_minimum(self):
        arguments = self.arguments()
        del arguments["execution_profile"]
        with self.assertRaises(AgentFault):
            compile_conversation(**arguments)
        self.assertEqual(PHASES, ("analyst", "counterpoint", "synthesis"))

    def test_chat_profile_rejects_arbitrary_schedules_and_profile_values(self):
        for change in (
            {"mode": "discuss"}, {"synthesizer_id": None}, {"synthesizer_id": "expert-3"},
            {"participant_ids": MEMBERS[:3]}, {"participant_ids": ("first-mate", "expert-1")},
            {"execution_profile": "anything"}, {"execution_profile": ["synthesis"]},
        ):
            with self.subTest(change=change), self.assertRaises(AgentFault):
                compile_conversation(**{**self.arguments(), **change})

    def test_chat_profile_refuses_retries_tools_and_extra_attempts(self):
        for name in ("turn_budget", "aggregate_budget"):
            for field, value in (("max_retries", 1), ("max_tool_calls", 1), ("max_attempts", 6)):
                arguments = self.arguments()
                arguments[name] = replace(arguments[name], **{field: value})
                with self.subTest(name=name, field=field), self.assertRaises(AgentFault):
                    compile_conversation(**arguments)

    def test_chat_profile_rejects_one_unit_aggregate_shortfalls_including_synthesis(self):
        for change in ({"tokens": 4999}, {"usd": "0.999999999999999999"}):
            arguments = self.arguments()
            arguments["aggregate_budget"] = replace(arguments["aggregate_budget"], **change)
            with self.subTest(change=change), self.assertRaises(AgentFault):
                compile_conversation(**arguments)
