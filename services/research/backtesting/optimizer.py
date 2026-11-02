"""Deterministic parameter search for offline research backtests.

Standard library only (no numpy, scipy or optuna). The caller supplies the
objective function. This module does not load data, run a simulator, persist
results, contact a provider or grant execution authority.

Objective contract::

    evaluate(params: dict, window: Window, market: str) -> Mapping[str, float]

``Window`` is a half-open range ``[start, end)`` of bar indices over the
caller's data. The caller maps it to its own data.

Search methods:

* ``grid``: full Cartesian product in declared dimension order (hard cap).
* ``random``: independent uniform samples.
* ``tpe``: Tree-structured Parzen Estimator (Bergstra et al. 2011).
* ``evolution``: (mu, lambda) evolution strategy with self-adaptive
  per-dimension step sizes (log-normal rule). It is not a genetic algorithm
  and not CMA-ES.
* ``pareto``: NSGA-II (Deb et al. 2002) for two or more objectives.
* ``market_only``: no search; run default parameters once per market and
  rank the markets.

Validation modes: ``single``, ``is_oos`` and ``walk_forward``. Pareto and
market-only modes support ``single`` only.

Every stochastic step uses ``random.Random(seed)``. The same inputs and seed
give identical trials. Only ``timing`` depends on the wall clock.
"""
from __future__ import annotations

import itertools
import math
import random
import statistics
import time
from dataclasses import asdict, dataclass, field
from statistics import NormalDist
from typing import Any, Callable, Iterator, Mapping, Sequence

MAX_TRIALS = 10_000
MAX_MARKETS = 40
MAX_GRID_SIZE = 10_000
MAX_FOLDS = 100
MAX_DIMENSIONS = 64
MAX_PBO_PARTITIONS = 16
MAX_PBO_WORK = 5_000_000
DEFAULT_TRIALS = 100
METHODS = ("grid", "random", "tpe", "evolution", "pareto", "market_only")
VALIDATION_MODES = ("single", "is_oos", "walk_forward")
DIRECTIONS = ("maximize", "minimize")
EULER_GAMMA = 0.5772156649015329
_NORMAL = NormalDist()
_FLOAT_DIGITS = 12

Evaluate = Callable[[dict, "Window", str], Mapping[str, float]]
ReturnsFn = Callable[[dict, "Window", str], Sequence[float]]
Progress = Callable[[int, "Trial | None"], None]
Stitch = Callable[[Sequence[tuple["Window", Mapping[str, float]]]], Mapping[str, float]]


class OptimizerLimitError(ValueError):
    """A hard or configured limit is exceeded. Raised before any trial runs."""


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _require(condition: bool, message: str, error: type[Exception] = ValueError) -> None:
    if not condition:
        raise error(message)


def _check_name(name: Any) -> None:
    _require(isinstance(name, str) and name.strip() == name and bool(name), "Parameter name must be a non-empty trimmed string")


def _clip(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


# --------------------------------------------------------------------------- parameter space


@dataclass(frozen=True)
class IntegerParam:
    """Integer values ``low, low + step, ...`` up to ``high`` (inclusive)."""
    name: str
    low: int
    high: int
    step: int = 1
    default: int | None = None
    kind: str = field(default="integer", init=False)

    def __post_init__(self) -> None:
        _check_name(self.name)
        for label in ("low", "high", "step"):
            _require(isinstance(getattr(self, label), int) and not isinstance(getattr(self, label), bool),
                     f"{self.name}: {label} must be an integer", TypeError)
        _require(self.low <= self.high, f"{self.name}: low must not exceed high")
        _require(self.step >= 1, f"{self.name}: step must be at least 1")
        _require(self.default is None or self.contains(self.default), f"{self.name}: default is outside the grid")

    numeric = True

    @property
    def count(self) -> int:
        return (self.high - self.low) // self.step + 1

    def values(self) -> list[int]:
        return [self.low + index * self.step for index in range(self.count)]

    def sample(self, rng: random.Random) -> int:
        return self.low + self.step * rng.randrange(self.count)

    def snap(self, value: float) -> int:
        _require(_is_number(value) and math.isfinite(value), f"{self.name}: value must be a finite number")
        index = int(_clip(round((value - self.low) / self.step), 0, self.count - 1))
        return self.low + index * self.step

    def contains(self, value: Any) -> bool:
        return (isinstance(value, int) and not isinstance(value, bool) and self.low <= value <= self.high
                and (value - self.low) % self.step == 0)

    def initial(self) -> int:
        return self.low if self.default is None else self.default

    def to_unit(self, value: float) -> float:
        return 0.0 if self.high == self.low else (value - self.low) / (self.high - self.low)

    def from_unit(self, unit: float) -> int:
        return self.snap(self.low + _clip(unit, 0.0, 1.0) * (self.high - self.low))

    def unit_step(self) -> float:
        return 1.0 if self.high == self.low else self.step / (self.high - self.low)


@dataclass(frozen=True)
class DecimalParam:
    """Real values in ``[low, high]``.

    With ``step`` the values are ``low + k * step`` (rounded to 12 decimals).
    Without ``step`` the dimension is continuous; grid search then needs
    ``grid_points`` (evenly spaced, both ends included).
    """
    name: str
    low: float
    high: float
    step: float | None = None
    default: float | None = None
    grid_points: int | None = None
    kind: str = field(default="decimal", init=False)

    def __post_init__(self) -> None:
        _check_name(self.name)
        for label in ("low", "high"):
            value = getattr(self, label)
            _require(_is_number(value) and math.isfinite(value), f"{self.name}: {label} must be a finite number", TypeError)
            object.__setattr__(self, label, float(value))
        _require(self.low <= self.high, f"{self.name}: low must not exceed high")
        if self.step is not None:
            _require(_is_number(self.step) and math.isfinite(self.step) and self.step > 0,
                     f"{self.name}: step must be a positive finite number")
            object.__setattr__(self, "step", float(self.step))
        if self.grid_points is not None:
            _require(isinstance(self.grid_points, int) and not isinstance(self.grid_points, bool) and self.grid_points >= 1,
                     f"{self.name}: grid_points must be a positive integer")
            _require(self.step is None, f"{self.name}: use step or grid_points, not both")
        if self.default is not None:
            _require(self.contains(self.default), f"{self.name}: default is outside the range or step")
            object.__setattr__(self, "default", float(self.default))

    numeric = True

    @property
    def count(self) -> int | None:
        if self.step is not None:
            return int(math.floor((self.high - self.low) / self.step + 1e-9)) + 1
        return self.grid_points

    def _at(self, index: int) -> float:
        return round(self.low + index * self.step, _FLOAT_DIGITS)

    def values(self) -> list[float]:
        if self.step is not None:
            return [self._at(index) for index in range(self.count)]
        _require(self.grid_points is not None, f"{self.name}: grid search needs step or grid_points")
        if self.grid_points == 1:
            return [self.low]
        width = self.high - self.low
        return [round(self.low + width * index / (self.grid_points - 1), _FLOAT_DIGITS) for index in range(self.grid_points)]

    def sample(self, rng: random.Random) -> float:
        if self.step is not None:
            return self._at(rng.randrange(self.count))
        return self.low + (self.high - self.low) * rng.random()

    def snap(self, value: float) -> float:
        _require(_is_number(value) and math.isfinite(value), f"{self.name}: value must be a finite number")
        if self.step is None:
            return float(_clip(float(value), self.low, self.high))
        return self._at(int(_clip(round((value - self.low) / self.step), 0, self.count - 1)))

    def contains(self, value: Any) -> bool:
        if not (_is_number(value) and math.isfinite(value)):
            return False
        tolerance = 1e-9 * max(1.0, abs(self.low), abs(self.high))
        if not self.low - tolerance <= value <= self.high + tolerance:
            return False
        return self.step is None or abs(self.snap(value) - value) <= tolerance

    def initial(self) -> float:
        return self.low if self.default is None else self.default

    def to_unit(self, value: float) -> float:
        return 0.0 if self.high == self.low else (value - self.low) / (self.high - self.low)

    def from_unit(self, unit: float) -> float:
        return self.snap(self.low + _clip(unit, 0.0, 1.0) * (self.high - self.low))

    def unit_step(self) -> float:
        if self.step is None or self.high == self.low:
            return 0.0
        return self.step / (self.high - self.low)


def _scalar_key(value: Any) -> tuple[str, Any]:
    return (type(value).__name__, value)


@dataclass(frozen=True)
class ChoiceParam:
    """One value from a fixed list of JSON scalars (str, int, float, bool, None)."""
    name: str
    choices: tuple
    default: Any = None
    kind: str = field(default="choice", init=False)

    def __post_init__(self) -> None:
        _check_name(self.name)
        _require(not isinstance(self.choices, (str, bytes)), f"{self.name}: choices must be a sequence", TypeError)
        object.__setattr__(self, "choices", tuple(self.choices))
        _require(bool(self.choices), f"{self.name}: choices must not be empty")
        for choice in self.choices:
            _require(choice is None or isinstance(choice, (str, bool, int, float)), f"{self.name}: choices must be JSON scalars", TypeError)
            _require(not isinstance(choice, float) or math.isfinite(choice), f"{self.name}: choices must be finite")
        _require(len({_scalar_key(choice) for choice in self.choices}) == len(self.choices), f"{self.name}: choices must be unique")
        _require(self.default is None or self.contains(self.default), f"{self.name}: default is not a choice")

    numeric = False

    @property
    def count(self) -> int:
        return len(self.choices)

    def values(self) -> list:
        return list(self.choices)

    def index(self, value: Any) -> int:
        key = _scalar_key(value)
        for position, choice in enumerate(self.choices):
            if _scalar_key(choice) == key:
                return position
        raise ValueError(f"{self.name}: {value!r} is not a choice")

    def sample(self, rng: random.Random) -> Any:
        return self.choices[rng.randrange(len(self.choices))]

    def snap(self, value: Any) -> Any:
        return self.choices[self.index(value)]

    def contains(self, value: Any) -> bool:
        try:
            self.index(value)
        except (ValueError, TypeError):
            return False
        return True

    def initial(self) -> Any:
        return self.choices[0] if self.default is None else self.default


@dataclass(frozen=True)
class BooleanParam(ChoiceParam):
    """``False`` or ``True``; the default is ``False`` unless given."""
    choices: tuple = (False, True)
    default: Any = False
    kind: str = field(default="boolean", init=False)

    def __post_init__(self) -> None:
        _require(tuple(self.choices) == (False, True), f"{self.name}: boolean choices are fixed")
        _require(isinstance(self.default, bool), f"{self.name}: boolean default must be a bool", TypeError)
        super().__post_init__()

    def initial(self) -> bool:
        return self.default


Dimension = IntegerParam | DecimalParam | ChoiceParam


@dataclass(frozen=True)
class ParameterSpace:
    """Ordered typed dimensions. An empty space is valid for market-only mode."""
    dimensions: tuple = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "dimensions", tuple(self.dimensions))
        _require(len(self.dimensions) <= MAX_DIMENSIONS, f"At most {MAX_DIMENSIONS} dimensions", OptimizerLimitError)
        for dimension in self.dimensions:
            _require(isinstance(dimension, (IntegerParam, DecimalParam, ChoiceParam)), "Unknown dimension type", TypeError)
        names = [dimension.name for dimension in self.dimensions]
        _require(len(set(names)) == len(names), "Dimension names must be unique")

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(dimension.name for dimension in self.dimensions)

    def grid_size(self) -> int:
        size = 1
        for dimension in self.dimensions:
            _require(dimension.count is not None, f"{dimension.name}: grid search needs step or grid_points")
            size *= dimension.count
        return size

    def grid(self, limit: int = MAX_GRID_SIZE) -> Iterator[dict]:
        """Yield every grid point. Raise ``OptimizerLimitError`` above ``limit``."""
        size = self.grid_size()
        _require(size <= min(limit, MAX_GRID_SIZE), f"Grid size {size} exceeds limit {min(limit, MAX_GRID_SIZE)}", OptimizerLimitError)
        names = self.names
        for combo in itertools.product(*(dimension.values() for dimension in self.dimensions)):
            yield dict(zip(names, combo))

    def sample(self, rng: random.Random) -> dict:
        return {dimension.name: dimension.sample(rng) for dimension in self.dimensions}

    def defaults(self) -> dict:
        return {dimension.name: dimension.initial() for dimension in self.dimensions}

    def snap(self, params: Mapping[str, Any]) -> dict:
        """Clip and round numeric values to range and step; check choices."""
        _require(set(params) == set(self.names), "Parameters must match the space dimensions exactly")
        return {dimension.name: dimension.snap(params[dimension.name]) for dimension in self.dimensions}

    def validate(self, params: Mapping[str, Any]) -> dict:
        _require(set(params) == set(self.names), "Parameters must match the space dimensions exactly")
        for dimension in self.dimensions:
            _require(dimension.contains(params[dimension.name]), f"{dimension.name}: {params[dimension.name]!r} is outside the space")
        return dict(params)

    def key(self, params: Mapping[str, Any]) -> tuple:
        return tuple(_scalar_key(params[name]) for name in self.names)

    def describe(self) -> list[dict]:
        return [asdict(dimension) for dimension in self.dimensions]


# --------------------------------------------------------------------------- configuration


@dataclass(frozen=True)
class Objective:
    metric: str
    direction: str = "maximize"

    def __post_init__(self) -> None:
        _require(isinstance(self.metric, str) and bool(self.metric), "Objective metric must be a non-empty string")
        _require(self.direction in DIRECTIONS, f"Objective direction must be one of {DIRECTIONS}")

    def orient(self, value: float) -> float:
        """Return a value where larger is always better."""
        return value if self.direction == "maximize" else -value


@dataclass(frozen=True)
class Window:
    """Half-open bar range ``[start, end)`` over the caller's data."""
    start: int
    end: int
    label: str = ""

    def __post_init__(self) -> None:
        _require(isinstance(self.start, int) and isinstance(self.end, int) and 0 <= self.start < self.end,
                 "Window needs integers 0 <= start < end")

    @property
    def length(self) -> int:
        return self.end - self.start


@dataclass(frozen=True)
class ValidationConfig:
    """``n_observations`` is the bar count of the caller's data.

    ``is_oos``: in-sample is ``[0, floor(n * is_fraction))``, out-of-sample the rest.
    ``walk_forward``: see ``walk_forward_windows``.
    ``top_k``: number of best distinct in-sample trials re-run out of sample.
    """
    mode: str = "single"
    n_observations: int = 0
    is_fraction: float = 0.7
    train_length: int | None = None
    test_length: int | None = None
    step: int | None = None
    anchored: bool = False
    top_k: int = 5

    def __post_init__(self) -> None:
        _require(self.mode in VALIDATION_MODES, f"Validation mode must be one of {VALIDATION_MODES}")
        _require(isinstance(self.n_observations, int) and self.n_observations >= 1, "n_observations must be a positive integer")
        _require(isinstance(self.top_k, int) and self.top_k >= 1, "top_k must be a positive integer")
        if self.mode == "is_oos":
            split_in_out_of_sample(self.n_observations, self.is_fraction)
        if self.mode == "walk_forward":
            _require(self.train_length is not None and self.test_length is not None, "walk_forward needs train_length and test_length")
            walk_forward_windows(self.n_observations, self.train_length, self.test_length, self.step, self.anchored)


@dataclass(frozen=True)
class TPESettings:
    n_startup: int = 10
    n_ei_candidates: int = 24
    gamma: float = 0.25
    prior_weight: float = 1.0

    def __post_init__(self) -> None:
        _require(self.n_startup >= 1 and self.n_ei_candidates >= 1, "TPE counts must be positive")
        _require(0.0 < self.gamma < 1.0 and self.prior_weight > 0.0, "TPE gamma must be in (0, 1) and prior_weight > 0")


@dataclass(frozen=True)
class EvolutionSettings:
    """(mu, lambda) evolution strategy: ``population`` = lambda, ``parents`` = mu."""
    population: int = 8
    parents: int = 3
    initial_sigma: float = 0.25
    min_sigma: float = 1e-4

    def __post_init__(self) -> None:
        _require(self.population >= 2 and 1 <= self.parents <= self.population, "Need population >= 2 and 1 <= parents <= population")
        _require(0.0 < self.min_sigma <= self.initial_sigma <= 1.0, "Need 0 < min_sigma <= initial_sigma <= 1")


@dataclass(frozen=True)
class NSGASettings:
    """NSGA-II with SBX crossover and polynomial mutation in unit space."""
    population: int = 20
    crossover_prob: float = 0.9
    eta_crossover: float = 15.0
    eta_mutation: float = 20.0
    mutation_prob: float | None = None

    def __post_init__(self) -> None:
        _require(self.population >= 2, "NSGA-II population must be at least 2")
        _require(0.0 <= self.crossover_prob <= 1.0, "crossover_prob must be in [0, 1]")
        _require(self.mutation_prob is None or 0.0 <= self.mutation_prob <= 1.0, "mutation_prob must be in [0, 1]")
        _require(self.eta_crossover > 0 and self.eta_mutation > 0, "eta values must be positive")


@dataclass(frozen=True)
class OptimizerConfig:
    """Run configuration. All fields are recorded in the result.

    ``max_trials`` counts trials per search (per fold in walk-forward). Default:
    the whole grid for ``grid``, 100 otherwise. ``time_budget_seconds`` is checked
    before each trial; a running trial is never interrupted.
    ``dispersion_penalty`` is k in ``mean - k * std`` (``mean + k * std`` for
    minimize) across markets. ``sharpe_periods_per_year`` converts annualized
    Sharpe metrics to per-bar units for the deflated Sharpe ratio.
    """
    method: str
    objectives: Any
    validation: ValidationConfig
    seed: int = 0
    max_trials: int | None = None
    markets: tuple = ("default",)
    market_weights: Mapping[str, float] | None = None
    dispersion_penalty: float = 0.25
    min_trades: float | None = None
    trades_metric: str = "trades"
    time_budget_seconds: float | None = None
    catch_errors: bool = True
    tpe: TPESettings = TPESettings()
    evolution: EvolutionSettings = EvolutionSettings()
    nsga: NSGASettings = NSGASettings()
    sharpe_metric: str = "sharpe"
    sharpe_periods_per_year: float | None = None
    returns_skew: float = 0.0
    returns_kurtosis: float = 3.0
    pbo_partitions: int = 8

    def __post_init__(self) -> None:
        _require(self.method in METHODS, f"Method must be one of {METHODS}")
        objectives = (self.objectives,) if isinstance(self.objectives, Objective) else tuple(self.objectives)
        _require(bool(objectives) and all(isinstance(item, Objective) for item in objectives), "objectives must be Objective values", TypeError)
        _require(len({item.metric for item in objectives}) == len(objectives), "Objective metrics must be unique")
        object.__setattr__(self, "objectives", objectives)
        if self.method == "pareto":
            _require(len(objectives) >= 2, "Pareto mode needs at least two objectives")
        else:
            _require(len(objectives) == 1, f"Method {self.method} needs exactly one objective")
        if self.method in ("pareto", "market_only"):
            _require(self.validation.mode == "single", f"Method {self.method} supports single validation only")
        _require(isinstance(self.seed, int) and not isinstance(self.seed, bool), "seed must be an integer", TypeError)
        _require(not isinstance(self.markets, str), "markets must be a sequence of names", TypeError)
        markets = tuple(self.markets)
        _require(bool(markets) and all(isinstance(item, str) and item for item in markets), "markets must be non-empty strings")
        _require(len(set(markets)) == len(markets), "markets must be unique")
        _require(len(markets) <= MAX_MARKETS, f"At most {MAX_MARKETS} markets", OptimizerLimitError)
        object.__setattr__(self, "markets", markets)
        weights = dict(self.market_weights or {})
        _require(set(weights) <= set(markets), "market_weights names unknown markets")
        for value in weights.values():
            _require(_is_number(value) and math.isfinite(value) and value > 0, "market weights must be positive finite numbers")
        object.__setattr__(self, "market_weights", {market: float(weights.get(market, 1.0)) for market in markets})
        _require(_is_number(self.dispersion_penalty) and math.isfinite(self.dispersion_penalty) and self.dispersion_penalty >= 0,
                 "dispersion_penalty must be a finite number >= 0")
        if self.max_trials is not None:
            _require(isinstance(self.max_trials, int) and self.max_trials >= 1, "max_trials must be a positive integer")
            _require(self.max_trials <= MAX_TRIALS, f"max_trials exceeds {MAX_TRIALS}", OptimizerLimitError)
        _require(self.min_trades is None or (_is_number(self.min_trades) and self.min_trades >= 0), "min_trades must be >= 0")
        _require(self.time_budget_seconds is None or (_is_number(self.time_budget_seconds) and self.time_budget_seconds >= 0),
                 "time_budget_seconds must be >= 0")
        _require(self.sharpe_periods_per_year is None or (_is_number(self.sharpe_periods_per_year) and self.sharpe_periods_per_year > 0),
                 "sharpe_periods_per_year must be positive")
        _require(isinstance(self.pbo_partitions, int) and 2 <= self.pbo_partitions <= MAX_PBO_PARTITIONS
                 and self.pbo_partitions % 2 == 0, f"pbo_partitions must be even in [2, {MAX_PBO_PARTITIONS}]")

    def to_dict(self) -> dict:
        return _jsonable(asdict(self))


# --------------------------------------------------------------------------- results


@dataclass(frozen=True)
class MarketEvaluation:
    market: str
    status: str  # "ok" or "failed"
    metrics: dict
    reason: str | None = None


@dataclass(frozen=True)
class Trial:
    """One evaluated parameter set. ``score`` is the robust single-objective
    value; ``objective_values`` holds every objective (Pareto mode)."""
    index: int
    params: dict
    window: Window
    markets: tuple
    status: str
    score: float | None
    objective_values: tuple | None
    dropped_markets: tuple = ()
    reason: str | None = None
    fold: int | None = None


@dataclass(frozen=True)
class OutOfSampleReport:
    trial_index: int
    params: dict
    in_sample_score: float
    window: Window
    markets: tuple
    status: str
    score: float | None
    degradation: float | None
    reason: str | None = None


@dataclass(frozen=True)
class DeflatedSharpe:
    sharpe: float
    n_trials: int
    sharpe_variance: float
    n_observations: int
    skew: float
    kurtosis: float
    expected_max_sharpe: float
    z: float
    probability: float


@dataclass(frozen=True)
class PBOResult:
    pbo: float
    n_trials: int
    n_periods_used: int
    n_partitions: int
    n_combinations: int
    metric: str
    logits: tuple


@dataclass(frozen=True)
class Diagnostics:
    deflated_sharpe: DeflatedSharpe | None
    deflated_sharpe_reason: str | None
    pbo: PBOResult | None
    pbo_reason: str | None


@dataclass(frozen=True)
class FoldResult:
    index: int
    train: Window
    test: Window
    seed: int
    trial_indices: tuple
    stop_reason: str
    best_trial_index: int | None
    params: dict | None
    out_of_sample: OutOfSampleReport | None
    diagnostics: Diagnostics


@dataclass(frozen=True)
class ValidationResult:
    mode: str
    in_sample: Window | None = None
    out_of_sample: Window | None = None
    selected: OutOfSampleReport | None = None
    top_k: tuple = ()
    folds: tuple = ()
    stitched: dict | None = None
    stitched_score: float | None = None
    stitched_dropped_markets: tuple = ()
    reason: str | None = None


@dataclass(frozen=True)
class MarketRank:
    rank: int | None
    market: str
    status: str
    value: float | None
    metrics: dict
    reason: str | None = None


@dataclass(frozen=True)
class OptimizationResult:
    """``best`` is the selected trial (walk-forward: the last fold's choice).
    ``pareto_front`` lists trial indices of the first non-dominated front."""
    method: str
    seed: int
    config: dict
    space: list
    trials: tuple
    best: Trial | None
    pareto_front: tuple
    validation: ValidationResult
    diagnostics: Diagnostics
    market_ranking: tuple
    stop_reason: str
    evaluation_count: int
    timing: dict

    def to_dict(self, include_timing: bool = True) -> dict:
        data = _jsonable(asdict(self))
        if not include_timing:
            data.pop("timing")
        return data


def _jsonable(value: Any) -> Any:
    """Recursively convert to JSON types. Non-finite floats become strings."""
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return value
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


# --------------------------------------------------------------------------- windows and aggregation


def split_in_out_of_sample(n_observations: int, fraction: float = 0.7) -> tuple[Window, Window]:
    """In-sample ``[0, floor(n * fraction))`` and out-of-sample ``[split, n)``."""
    _require(isinstance(n_observations, int) and n_observations >= 2, "IS/OOS needs at least two observations")
    _require(_is_number(fraction) and 0.0 < fraction < 1.0, "is_fraction must be in (0, 1)")
    split = math.floor(n_observations * fraction + 1e-9)
    _require(0 < split < n_observations, "IS/OOS split leaves an empty window")
    return Window(0, split, "in_sample"), Window(split, n_observations, "out_of_sample")


def walk_forward_windows(n_observations: int, train_length: int, test_length: int, step: int | None = None,
                         anchored: bool = False) -> tuple[tuple[Window, Window], ...]:
    """Ordered (train, test) folds.

    Fold i starts at ``s = i * step`` (``step`` defaults to ``test_length``).
    Rolling: train ``[s, s + train)``; anchored: train ``[0, s + train)``.
    Test is ``[s + train, s + train + test)``. Folds that do not fit are dropped.
    ``step >= test_length`` is required so test windows never overlap.
    """
    for label, value in (("train_length", train_length), ("test_length", test_length)):
        _require(isinstance(value, int) and not isinstance(value, bool) and value >= 1, f"{label} must be a positive integer")
    step = test_length if step is None else step
    _require(isinstance(step, int) and step >= test_length, "step must be an integer >= test_length")
    folds = []
    start = 0
    while start + train_length + test_length <= n_observations:
        train_end = start + train_length
        index = len(folds)
        folds.append((Window(0 if anchored else start, train_end, f"fold{index}_train"),
                      Window(train_end, train_end + test_length, f"fold{index}_test")))
        _require(len(folds) <= MAX_FOLDS, f"Walk-forward exceeds {MAX_FOLDS} folds", OptimizerLimitError)
        start += step
    _require(bool(folds), "Walk-forward configuration produces no fold")
    return tuple(folds)


def weighted_mean_std(values: Sequence[float], weights: Sequence[float] | None = None) -> tuple[float, float]:
    """Weighted mean and weighted population standard deviation."""
    _require(bool(values), "Need at least one value")
    weights = [1.0] * len(values) if weights is None else list(weights)
    _require(len(weights) == len(values) and all(weight > 0 for weight in weights), "Weights must be positive and match values")
    total = math.fsum(weights)
    mean = math.fsum(weight * value for weight, value in zip(weights, values)) / total
    variance = math.fsum(weight * (value - mean) ** 2 for weight, value in zip(weights, values)) / total
    return mean, math.sqrt(variance)


def robust_score(values: Sequence[float], weights: Sequence[float] | None = None, *, direction: str = "maximize",
                 penalty: float = 0.25) -> float:
    """Multi-market score: ``mean - k * std`` (maximize) or ``mean + k * std`` (minimize)."""
    _require(direction in DIRECTIONS, f"direction must be one of {DIRECTIONS}")
    mean, std = weighted_mean_std(values, weights)
    return mean - penalty * std if direction == "maximize" else mean + penalty * std


def stitch_metrics(parts: Sequence[tuple[Window, Mapping[str, float]]]) -> dict:
    """Default walk-forward OOS stitching over metrics present in every part.

    ``total_return``: compounded. ``trades``: summed. ``max_drawdown``: the
    value with the largest magnitude. Any other metric: mean weighted by
    window length. Callers with return series should supply their own.
    """
    if not parts:
        return {}
    names = set(parts[0][1])
    for _, metrics in parts[1:]:
        names &= set(metrics)
    stitched = {}
    for name in sorted(names):
        values = [float(metrics[name]) for _, metrics in parts]
        if name == "total_return":
            product = 1.0
            for value in values:
                product *= 1.0 + value
            stitched[name] = product - 1.0
        elif name == "trades":
            stitched[name] = math.fsum(values)
        elif name == "max_drawdown":
            stitched[name] = max(values, key=abs)
        else:
            lengths = [window.length for window, _ in parts]
            stitched[name] = math.fsum(length * value for length, value in zip(lengths, values)) / sum(lengths)
    return stitched


# --------------------------------------------------------------------------- Pareto helpers


def _dominates(a: Sequence[float], b: Sequence[float]) -> bool:
    """``a`` dominates ``b`` (both oriented so larger is better)."""
    return all(x >= y for x, y in zip(a, b)) and any(x > y for x, y in zip(a, b))


def non_dominated_sort(vectors: Sequence[Sequence[float]]) -> list[list[int]]:
    """Deb's fast non-dominated sort; vectors are oriented so larger is better."""
    count = len(vectors)
    dominated_by = [[] for _ in range(count)]
    domination_count = [0] * count
    fronts: list[list[int]] = [[]]
    for i in range(count):
        for j in range(i + 1, count):
            if _dominates(vectors[i], vectors[j]):
                dominated_by[i].append(j)
                domination_count[j] += 1
            elif _dominates(vectors[j], vectors[i]):
                dominated_by[j].append(i)
                domination_count[i] += 1
    fronts[0] = [i for i in range(count) if domination_count[i] == 0]
    while fronts[-1]:
        following = []
        for i in fronts[-1]:
            for j in dominated_by[i]:
                domination_count[j] -= 1
                if domination_count[j] == 0:
                    following.append(j)
        fronts.append(sorted(following))
    return fronts[:-1]


def crowding_distance(vectors: Sequence[Sequence[float]], front: Sequence[int]) -> dict[int, float]:
    distance = {index: 0.0 for index in front}
    if len(front) <= 2:
        return {index: math.inf for index in front}
    for objective in range(len(vectors[front[0]])):
        ordered = sorted(front, key=lambda index: (vectors[index][objective], index))
        low, high = vectors[ordered[0]][objective], vectors[ordered[-1]][objective]
        distance[ordered[0]] = distance[ordered[-1]] = math.inf
        if high == low:
            continue
        for position in range(1, len(ordered) - 1):
            distance[ordered[position]] += (vectors[ordered[position + 1]][objective]
                                            - vectors[ordered[position - 1]][objective]) / (high - low)
    return distance


def pareto_front(points: Sequence[Sequence[float]], directions: Sequence[str]) -> list[int]:
    """Indices of non-dominated points (equal points are all kept)."""
    _require(all(direction in DIRECTIONS for direction in directions), f"directions must be in {DIRECTIONS}")
    oriented = [tuple(value if direction == "maximize" else -value for value, direction in zip(point, directions))
                for point in points]
    return non_dominated_sort(oriented)[0] if oriented else []


# --------------------------------------------------------------------------- overfitting diagnostics


def expected_max_sharpe(n_trials: int, sharpe_variance: float) -> float:
    """Expected maximum Sharpe of ``n_trials`` unskilled trials (False Strategy Theorem)."""
    _require(isinstance(n_trials, int) and n_trials >= 2, "Need at least two trials")
    _require(sharpe_variance >= 0, "Sharpe variance must be >= 0")
    return math.sqrt(sharpe_variance) * ((1 - EULER_GAMMA) * _NORMAL.inv_cdf(1 - 1 / n_trials)
                                         + EULER_GAMMA * _NORMAL.inv_cdf(1 - 1 / (n_trials * math.e)))


def deflated_sharpe_ratio(sharpe: float, n_trials: int, sharpe_variance: float, n_observations: int,
                          skew: float = 0.0, kurtosis: float = 3.0) -> DeflatedSharpe:
    """Bailey and Lopez de Prado (2014) deflated Sharpe ratio.

    All Sharpe inputs are per observation (not annualized). ``kurtosis`` is
    the raw (non-excess) kurtosis; 3 means normal returns.
    """
    _require(isinstance(n_observations, int) and n_observations >= 2, "Need at least two observations")
    for value in (sharpe, sharpe_variance, skew, kurtosis):
        _require(_is_number(value) and math.isfinite(value), "DSR inputs must be finite")
    benchmark = expected_max_sharpe(n_trials, sharpe_variance)
    radicand = 1 - skew * sharpe + (kurtosis - 1) / 4 * sharpe ** 2
    _require(radicand > 0, "Non-positive Sharpe standard error term")
    z = (sharpe - benchmark) * math.sqrt(n_observations - 1) / math.sqrt(radicand)
    return DeflatedSharpe(sharpe, n_trials, sharpe_variance, n_observations, skew, kurtosis, benchmark, z, _NORMAL.cdf(z))


def _performance(total: float, square: float, count: int, metric: str) -> float:
    mean = total / count
    if metric == "mean":
        return mean
    variance = max(0.0, (square - count * mean * mean) / (count - 1))
    if variance <= 0:
        return 0.0 if mean == 0 else math.copysign(math.inf, mean)
    return mean / math.sqrt(variance)


def probability_of_backtest_overfitting(returns: Sequence[Sequence[float]], n_partitions: int = 8,
                                        metric: str = "sharpe") -> PBOResult:
    """CSCV probability of backtest overfitting (Bailey et al. 2017).

    ``returns`` is a trials x periods matrix. Periods are cut into
    ``n_partitions`` equal contiguous blocks; trailing periods that do not fill
    a block are dropped. For every choice of half the blocks as in-sample the
    best in-sample trial is ranked out of sample; ``w = rank / (N + 1)`` with
    average ranks for ties, logit ``ln(w / (1 - w))``. PBO is the share of
    logits <= 0. ``metric`` is ``sharpe`` (mean / sample std) or ``mean``.
    """
    _require(metric in ("sharpe", "mean"), "metric must be sharpe or mean")
    _require(isinstance(n_partitions, int) and 2 <= n_partitions <= MAX_PBO_PARTITIONS and n_partitions % 2 == 0,
             f"n_partitions must be even in [2, {MAX_PBO_PARTITIONS}]")
    rows = [list(map(float, row)) for row in returns]
    _require(len(rows) >= 2, "PBO needs at least two trials")
    periods = len(rows[0])
    _require(all(len(row) == periods for row in rows), "All trials need the same number of periods")
    _require(all(math.isfinite(value) for row in rows for value in row), "Returns must be finite")
    block = periods // n_partitions
    _require(block >= 2, "Each partition needs at least two periods")
    combinations = list(itertools.combinations(range(n_partitions), n_partitions // 2))
    _require(len(rows) * len(combinations) <= MAX_PBO_WORK, "PBO matrix too large", OptimizerLimitError)
    sums = [[math.fsum(row[b * block:(b + 1) * block]) for b in range(n_partitions)] for row in rows]
    squares = [[math.fsum(value * value for value in row[b * block:(b + 1) * block]) for b in range(n_partitions)] for row in rows]
    half = block * (n_partitions // 2)
    logits = []
    for chosen in combinations:
        others = [b for b in range(n_partitions) if b not in chosen]
        in_sample = [_performance(sum(s[b] for b in chosen), sum(q[b] for b in chosen), half, metric)
                     for s, q in zip(sums, squares)]
        out_sample = [_performance(sum(s[b] for b in others), sum(q[b] for b in others), half, metric)
                      for s, q in zip(sums, squares)]
        best = max(range(len(rows)), key=lambda index: (in_sample[index], -index))
        target = out_sample[best]
        below = sum(1 for value in out_sample if value < target)
        equal = sum(1 for value in out_sample if value == target)
        rank = below + (equal + 1) / 2
        omega = rank / (len(rows) + 1)
        logits.append(math.log(omega / (1 - omega)))
    pbo = sum(1 for value in logits if value <= 0) / len(logits)
    return PBOResult(pbo, len(rows), block * n_partitions, n_partitions, len(combinations), metric, tuple(logits))


# --------------------------------------------------------------------------- search methods
#
# Each method is a generator over candidate parameter dicts. The runner
# appends exactly one Trial to ``history`` after each ``yield`` before asking
# for the next candidate, so a generator can read the outcome of what it yielded.


def _grid_search(space: ParameterSpace, rng: random.Random, config: OptimizerConfig, history: list, fitness) -> Iterator[dict]:
    yield from space.grid()


def _random_search(space: ParameterSpace, rng: random.Random, config: OptimizerConfig, history: list, fitness) -> Iterator[dict]:
    while True:
        yield space.sample(rng)


def _log_normal_pdf(x: float, mu: float, sigma: float) -> float:
    """Log density of a normal truncated to [0, 1]."""
    mass = _NORMAL.cdf((1.0 - mu) / sigma) - _NORMAL.cdf(-mu / sigma)
    z = (x - mu) / sigma
    return -0.5 * z * z - math.log(sigma * math.sqrt(2 * math.pi) * max(mass, 1e-300))


def _log_sum_exp(values: Sequence[float]) -> float:
    top = max(values)
    return top + math.log(math.fsum(math.exp(value - top) for value in values))


class _NumericParzen:
    """Truncated Gaussian mixture on unit space: one kernel per observation
    plus a wide prior kernel at 0.5. Kernel width is the larger gap to the
    neighbouring observations, clipped to [1 / min(100, n + 1), 1]."""

    def __init__(self, observations: Sequence[float], prior_weight: float) -> None:
        points = sorted(observations)
        count = len(points)
        edges = [0.0] + points + [1.0]
        floor = 1.0 / min(100.0, count + 1.0)
        sigmas = [_clip(max(edges[i + 1] - edges[i], edges[i + 2] - edges[i + 1]), floor, 1.0) for i in range(count)]
        self.mus = points + [0.5]
        self.sigmas = sigmas + [1.0]
        weights = [1.0] * count + [prior_weight]
        total = math.fsum(weights)
        self.weights = [weight / total for weight in weights]

    def sample(self, rng: random.Random) -> float:
        draw, cumulative, component = rng.random(), 0.0, len(self.weights) - 1
        for index, weight in enumerate(self.weights):
            cumulative += weight
            if draw < cumulative:
                component = index
                break
        for _ in range(100):
            value = rng.gauss(self.mus[component], self.sigmas[component])
            if 0.0 <= value <= 1.0:
                return value
        return _clip(value, 0.0, 1.0)

    def log_pdf(self, x: float) -> float:
        return _log_sum_exp([math.log(weight) + _log_normal_pdf(x, mu, sigma)
                             for weight, mu, sigma in zip(self.weights, self.mus, self.sigmas)])


class _CategoricalParzen:
    """Smoothed frequencies: ``(count_c + prior_weight) / (n + k * prior_weight)``."""

    def __init__(self, indices: Sequence[int], size: int, prior_weight: float) -> None:
        counts = [prior_weight] * size
        for index in indices:
            counts[index] += 1.0
        total = math.fsum(counts)
        self.probabilities = [count / total for count in counts]

    def sample(self, rng: random.Random) -> int:
        draw, cumulative = rng.random(), 0.0
        for index, probability in enumerate(self.probabilities):
            cumulative += probability
            if draw < cumulative:
                return index
        return len(self.probabilities) - 1

    def log_pdf(self, index: int) -> float:
        return math.log(self.probabilities[index])


def _ranked(history: Sequence[Trial], fitness) -> list[Trial]:
    return sorted(history, key=lambda trial: (-fitness(trial), trial.index))


def _tpe_search(space: ParameterSpace, rng: random.Random, config: OptimizerConfig, history: list, fitness) -> Iterator[dict]:
    """TPE over distinct evaluated points (repeats carry no information).

    The best ``ceil(gamma * n_ok)`` points form the good set (density l); the
    rest, including failed trials, form the bad set (density g). Sample
    ``n_ei_candidates`` points from l per dimension and keep the one that
    maximizes the sum of ``log l - log g``. Candidates that were already
    evaluated are skipped; if all were, a uniform random point is used.
    """
    settings = config.tpe
    while True:
        distinct: dict[tuple, Trial] = {}
        for trial in history:
            distinct.setdefault(space.key(trial.params), trial)
        ranked = _ranked(list(distinct.values()), fitness)
        ok = [trial for trial in ranked if fitness(trial) > -math.inf]
        if len(history) < settings.n_startup or not ok:
            yield space.sample(rng)
            continue
        n_good = max(1, math.ceil(settings.gamma * len(ok)))
        good, bad = ranked[:n_good], ranked[n_good:]
        models = []
        for dimension in space.dimensions:
            if dimension.numeric:
                build = lambda trials, d=dimension: _NumericParzen([d.to_unit(t.params[d.name]) for t in trials], settings.prior_weight)
            else:
                build = lambda trials, d=dimension: _CategoricalParzen([d.index(t.params[d.name]) for t in trials], d.count, settings.prior_weight)
            models.append((dimension, build(good), build(bad)))
        best_params, best_value = None, -math.inf
        for _ in range(settings.n_ei_candidates):
            params, value = {}, 0.0
            for dimension, good_model, bad_model in models:
                if dimension.numeric:
                    chosen = dimension.from_unit(good_model.sample(rng))
                    unit = dimension.to_unit(chosen)
                    value += good_model.log_pdf(unit) - bad_model.log_pdf(unit)
                else:
                    position = good_model.sample(rng)
                    chosen = dimension.choices[position]
                    value += good_model.log_pdf(position) - bad_model.log_pdf(position)
                params[dimension.name] = chosen
            if space.key(params) not in distinct and (best_params is None or value > best_value):
                best_params, best_value = params, value
        yield best_params if best_params is not None else space.sample(rng)


def _reflect(unit: float) -> float:
    if unit < 0.0:
        unit = -unit
    if unit > 1.0:
        unit = 2.0 - unit
    return _clip(unit, 0.0, 1.0)


def _evolution_search(space: ParameterSpace, rng: random.Random, config: OptimizerConfig, history: list, fitness) -> Iterator[dict]:
    """(mu/mu_I, lambda) evolution strategy (comma selection, no elitism).

    Each individual carries one step size per dimension in unit space.
    Every child starts from the centroid of the mu best individuals of the
    last generation (global intermediate recombination of numeric values
    and step sizes); a categorical value comes from one random parent.
    Step sizes mutate by ``sigma * exp(tau0 * N + tau_i * N_i)`` with
    ``tau0 = 1/sqrt(2n)`` and ``tau_i = 1/sqrt(2 sqrt(n))``; numeric values by
    ``u + sigma * N_i`` (reflected into [0, 1], then snapped). A categorical
    value is resampled with probability ``clip(sigma, 0.02, 0.5)``. Stepped
    dimensions keep sigma >= 0.3 step so they can still move.
    """
    settings = config.evolution
    dimensions = space.dimensions
    size = len(dimensions)
    tau_global, tau_local = 1 / math.sqrt(2 * size), 1 / math.sqrt(2 * math.sqrt(size))
    floors = [max(settings.min_sigma, 0.3 * dimension.unit_step()) if dimension.numeric else settings.min_sigma
              for dimension in dimensions]
    offspring = [(space.sample(rng), [settings.initial_sigma] * size) for _ in range(settings.population)]
    while True:
        start = len(history)
        for params, _ in offspring:
            yield params
        evaluated = history[start:start + len(offspring)]
        order = sorted(range(len(offspring)), key=lambda i: (-fitness(evaluated[i]), evaluated[i].index))
        parents = [offspring[i] for i in order[:settings.parents]]
        centroid_units = {dimension.name: math.fsum(dimension.to_unit(p[0][dimension.name]) for p in parents) / len(parents)
                          for dimension in dimensions if dimension.numeric}
        centroid_sigmas = [math.fsum(p[1][position] for p in parents) / len(parents) for position in range(size)]
        offspring = []
        for _ in range(settings.population):
            shared = rng.gauss(0.0, 1.0)
            params, sigmas = {}, []
            for position, dimension in enumerate(dimensions):
                sigma = centroid_sigmas[position] * math.exp(tau_global * shared + tau_local * rng.gauss(0.0, 1.0))
                sigma = _clip(sigma, floors[position], 1.0)
                sigmas.append(sigma)
                if dimension.numeric:
                    unit = centroid_units[dimension.name] + sigma * rng.gauss(0.0, 1.0)
                    params[dimension.name] = dimension.from_unit(_reflect(unit))
                else:
                    value = parents[rng.randrange(len(parents))][0][dimension.name]
                    if rng.random() < _clip(sigma, 0.02, 0.5):
                        value = dimension.sample(rng)
                    params[dimension.name] = value
            offspring.append((params, sigmas))


def _rank_and_crowd(trials: Sequence[Trial], vector) -> tuple[dict[int, int], dict[int, float]]:
    """Front rank and crowding per position. Failed trials form the last front."""
    ok = [position for position, trial in enumerate(trials) if vector(trial) is not None]
    failed = [position for position, trial in enumerate(trials) if vector(trial) is None]
    vectors = {position: vector(trials[position]) for position in ok}
    local = [vectors[position] for position in ok]
    fronts = [[ok[i] for i in front] for front in non_dominated_sort(local)] if ok else []
    if failed:
        fronts.append(failed)
    rank, crowd = {}, {}
    for level, front in enumerate(fronts):
        rows = {position: vectors.get(position, ()) for position in front}
        distances = crowding_distance(rows, front) if front and front[0] in vectors else {p: 0.0 for p in front}
        for position in front:
            rank[position] = level
            crowd[position] = distances[position]
    return rank, crowd


def _nsga2_search(space: ParameterSpace, rng: random.Random, config: OptimizerConfig, history: list, vector) -> Iterator[dict]:
    """NSGA-II: binary tournament on (front rank, crowding), SBX crossover and
    polynomial mutation for numeric dimensions in unit space, uniform swap and
    resampling for categorical dimensions, then (parents + children) survival
    by fronts and crowding distance.

    Stepped dimensions move at least one step when the mutation delta is not
    zero. A child equal to an evaluated point is mutated again (up to 20 times)
    so small discrete spaces keep exploring.
    """
    settings = config.nsga
    dimensions = space.dimensions
    size = settings.population
    mutation = settings.mutation_prob if settings.mutation_prob is not None else 1.0 / len(dimensions)
    exponent = 1 / (settings.eta_mutation + 1)

    def mutate(child: dict, probability: float) -> None:
        for dimension in dimensions:
            if rng.random() >= probability:
                continue
            if not dimension.numeric:
                child[dimension.name] = dimension.sample(rng)
                continue
            draw = rng.random()
            delta = (2 * draw) ** exponent - 1 if draw < 0.5 else 1 - (2 * (1 - draw)) ** exponent
            before = child[dimension.name]
            unit = dimension.to_unit(before)
            after = dimension.from_unit(unit + delta)
            if after == before and delta != 0 and dimension.unit_step() > 0:
                after = dimension.from_unit(unit + math.copysign(dimension.unit_step(), delta))
                if after == before:
                    after = dimension.from_unit(unit - math.copysign(dimension.unit_step(), delta))
            child[dimension.name] = after

    start = len(history)
    for _ in range(size):
        yield space.sample(rng)
    population = history[start:start + size]
    while True:
        rank, crowd = _rank_and_crowd(population, vector)

        def tournament() -> Trial:
            a, b = rng.randrange(len(population)), rng.randrange(len(population))
            return population[min((a, b), key=lambda p: (rank[p], -crowd[p], population[p].index))]

        children: list[dict] = []
        seen = {space.key(trial.params) for trial in history}
        while len(children) < size:
            first, second = dict(tournament().params), dict(tournament().params)
            if rng.random() < settings.crossover_prob:
                for dimension in dimensions:
                    if rng.random() >= 0.5:
                        continue
                    if dimension.numeric:
                        x1, x2 = dimension.to_unit(first[dimension.name]), dimension.to_unit(second[dimension.name])
                        draw = rng.random()
                        exponent = 1 / (settings.eta_crossover + 1)
                        beta = (2 * draw) ** exponent if draw <= 0.5 else (1 / (2 * (1 - draw))) ** exponent
                        first[dimension.name] = dimension.from_unit(0.5 * ((1 + beta) * x1 + (1 - beta) * x2))
                        second[dimension.name] = dimension.from_unit(0.5 * ((1 - beta) * x1 + (1 + beta) * x2))
                    else:
                        first[dimension.name], second[dimension.name] = second[dimension.name], first[dimension.name]
            for child in (first, second):
                mutate(child, mutation)
                for _ in range(20):
                    if space.key(child) not in seen:
                        break
                    mutate(child, max(mutation, 0.5))
                seen.add(space.key(child))
                if len(children) < size:
                    children.append(child)
        start = len(history)
        for child in children:
            yield child
        combined = list(population) + history[start:start + size]
        rank, crowd = _rank_and_crowd(combined, vector)
        order = sorted(range(len(combined)), key=lambda p: (rank[p], -crowd[p], combined[p].index))
        population = [combined[p] for p in order[:size]]


_METHODS = {"grid": _grid_search, "random": _random_search, "tpe": _tpe_search,
            "evolution": _evolution_search, "pareto": _nsga2_search}


# --------------------------------------------------------------------------- runner


class _Runner:
    def __init__(self, evaluate: Evaluate, space: ParameterSpace, config: OptimizerConfig, progress: Progress | None,
                 returns_fn: ReturnsFn | None, clock: Callable[[], float]) -> None:
        self.evaluate, self.space, self.config = evaluate, space, config
        self.progress, self.returns_fn, self.clock = progress, returns_fn, clock
        self.started = clock()
        self.trials: list[Trial] = []
        self.cache: dict[tuple, MarketEvaluation] = {}
        self.evaluation_count = 0
        self.objective = config.objectives[0]
        self.required = {objective.metric for objective in config.objectives}
        if config.min_trades is not None:
            self.required.add(config.trades_metric)

    # -- evaluation

    def out_of_time(self) -> bool:
        budget = self.config.time_budget_seconds
        return budget is not None and self.clock() - self.started >= budget

    def evaluate_market(self, params: dict, window: Window, market: str) -> MarketEvaluation:
        key = (self.space.key(params), window.start, window.end, market)
        if key in self.cache:
            return self.cache[key]
        self.evaluation_count += 1
        try:
            raw = self.evaluate(dict(params), window, market)
        except Exception as error:  # noqa: BLE001 - recorded as a failed market when catch_errors
            if not self.config.catch_errors:
                raise
            result = MarketEvaluation(market, "failed", {}, f"error: {type(error).__name__}: {str(error)[:200]}")
        else:
            result = self._check_metrics(raw, market)
        self.cache[key] = result
        return result

    def _check_metrics(self, raw: Any, market: str) -> MarketEvaluation:
        if not isinstance(raw, Mapping):
            return MarketEvaluation(market, "failed", {}, "evaluate did not return a mapping")
        metrics, reason = {}, None
        for name, value in raw.items():
            if not isinstance(name, str) or not _is_number(value):
                metrics[str(name)] = math.nan
                reason = reason or f"non-numeric metric {name!r}"
                continue
            metrics[name] = float(value)
            if not math.isfinite(metrics[name]):
                reason = reason or f"non-finite metric {name!r}"
        missing = sorted(self.required - set(metrics))
        if reason is None and missing:
            reason = f"missing metric {missing[0]!r}"
        if reason is None and self.config.min_trades is not None and metrics[self.config.trades_metric] < self.config.min_trades:
            reason = f"trades below minimum {self.config.min_trades}"
        return MarketEvaluation(market, "failed" if reason else "ok", metrics, reason)

    def evaluate_params(self, params: dict, window: Window) -> tuple[tuple, str, float | None, tuple | None, tuple, str | None]:
        evaluations = tuple(self.evaluate_market(params, window, market) for market in self.config.markets)
        ok = [item for item in evaluations if item.status == "ok"]
        dropped = tuple(item.market for item in evaluations if item.status != "ok")
        if not ok:
            return evaluations, "failed", None, None, dropped, "all markets failed"
        weights = [self.config.market_weights[item.market] for item in ok]
        values = tuple(robust_score([item.metrics[objective.metric] for item in ok], weights, direction=objective.direction,
                                    penalty=self.config.dispersion_penalty) for objective in self.config.objectives)
        score = values[0] if len(values) == 1 else None
        return evaluations, "ok", score, values, dropped, None

    def run_trial(self, params: dict, window: Window, fold: int | None) -> Trial:
        params = self.space.validate(self.space.snap(params))
        evaluations, status, score, values, dropped, reason = self.evaluate_params(params, window)
        trial = Trial(len(self.trials), params, window, evaluations, status, score, values, dropped, reason, fold)
        self.trials.append(trial)
        return trial

    # -- ranking

    def fitness(self, trial: Trial) -> float:
        return -math.inf if trial.status != "ok" else self.objective.orient(trial.score)

    def vector(self, trial: Trial) -> tuple | None:
        if trial.status != "ok":
            return None
        return tuple(objective.orient(value) for objective, value in zip(self.config.objectives, trial.objective_values))

    def best(self, trials: Sequence[Trial]) -> Trial | None:
        ok = [trial for trial in trials if trial.status == "ok"]
        return _ranked(ok, self.fitness)[0] if ok else None

    def distinct_ranked(self, trials: Sequence[Trial]) -> list[Trial]:
        seen, result = set(), []
        for trial in _ranked([trial for trial in trials if trial.status == "ok"], self.fitness):
            key = self.space.key(trial.params)
            if key not in seen:
                seen.add(key)
                result.append(trial)
        return result

    # -- search

    def budget(self) -> int:
        if self.config.max_trials is not None:
            return self.config.max_trials
        return MAX_GRID_SIZE if self.config.method == "grid" else DEFAULT_TRIALS

    def search(self, window: Window, seed: int, fold: int | None) -> tuple[list[Trial], str]:
        rng = random.Random(seed)
        history: list[Trial] = []
        pareto = self.config.method == "pareto"
        generator = _METHODS[self.config.method](self.space, rng, self.config, history, self.vector if pareto else self.fitness)
        budget, best = self.budget(), None
        while True:
            if len(history) >= budget:
                return history, "budget"
            if self.out_of_time():
                return history, "time_budget"
            try:
                params = next(generator)
            except StopIteration:
                return history, "exhausted"
            trial = self.run_trial(params, window, fold)
            history.append(trial)
            if not pareto and trial.status == "ok" and (best is None or self.fitness(trial) > self.fitness(best)):
                best = trial
            if self.progress is not None:
                self.progress(trial.index, best)

    def out_of_sample(self, trial: Trial, window: Window) -> OutOfSampleReport:
        evaluations, status, score, _, _, reason = self.evaluate_params(trial.params, window)
        degradation = None if score is None else self.objective.orient(score) - self.objective.orient(trial.score)
        return OutOfSampleReport(trial.index, dict(trial.params), trial.score, window, evaluations, status, score, degradation, reason)

    # -- diagnostics

    def diagnostics(self, trials: Sequence[Trial], best: Trial | None, window: Window) -> Diagnostics:
        if self.config.method == "pareto":
            reason = "not defined for Pareto mode"
            return Diagnostics(None, reason, None, reason)
        distinct = self.distinct_ranked(trials)
        return Diagnostics(*self._dsr(distinct, best, window), *self._pbo(distinct, window))

    def _sharpe(self, trial: Trial) -> float | None:
        ok = [item for item in trial.markets if item.status == "ok"]
        if not ok or any(self.config.sharpe_metric not in item.metrics for item in ok):
            return None
        mean, _ = weighted_mean_std([item.metrics[self.config.sharpe_metric] for item in ok],
                                    [self.config.market_weights[item.market] for item in ok])
        if self.config.sharpe_periods_per_year is not None:
            mean /= math.sqrt(self.config.sharpe_periods_per_year)
        return mean

    def _dsr(self, distinct: list[Trial], best: Trial | None, window: Window) -> tuple[DeflatedSharpe | None, str | None]:
        if best is None:
            return None, "no successful trial"
        sharpes = [self._sharpe(trial) for trial in distinct]
        if any(value is None for value in sharpes):
            return None, f"metric {self.config.sharpe_metric!r} missing"
        if len(sharpes) < 2:
            return None, "needs at least two distinct successful trials"
        if window.length < 2:
            return None, "needs at least two observations"
        try:
            return deflated_sharpe_ratio(self._sharpe(best), len(sharpes), statistics.variance(sharpes), window.length,
                                         float(self.config.returns_skew), float(self.config.returns_kurtosis)), None
        except ValueError as error:
            return None, str(error)

    def market_dsr(self, trial: Trial, ranking: Sequence["MarketRank"],
                   window: Window) -> tuple[DeflatedSharpe | None, str | None]:
        """Deflated Sharpe of the top-ranked market, with one trial per market tried."""
        ok = [item for item in trial.markets if item.status == "ok"]
        if not ok:
            return None, "no successful market"
        metric = self.config.sharpe_metric
        if any(metric not in item.metrics for item in ok):
            return None, f"metric {metric!r} missing"
        if len(ok) < 2:
            return None, "needs at least two markets with results"
        if window.length < 2:
            return None, "needs at least two observations"
        scale = math.sqrt(self.config.sharpe_periods_per_year) if self.config.sharpe_periods_per_year is not None else 1.0
        sharpes = {item.market: item.metrics[metric] / scale for item in ok}
        try:
            return deflated_sharpe_ratio(sharpes[ranking[0].market], len(sharpes), statistics.variance(sharpes.values()),
                                         window.length, float(self.config.returns_skew),
                                         float(self.config.returns_kurtosis)), None
        except ValueError as error:
            return None, str(error)

    def _pbo(self, distinct: list[Trial], window: Window) -> tuple[PBOResult | None, str | None]:
        if self.returns_fn is None:
            return None, "no returns function supplied"
        if len(distinct) < 2:
            return None, "needs at least two distinct successful trials"
        matrix = []
        try:
            for trial in distinct:
                ok = [item for item in trial.markets if item.status == "ok"]
                series = [list(map(float, self.returns_fn(dict(trial.params), window, item.market))) for item in ok]
                _require(len({len(values) for values in series}) == 1, "market return series differ in length")
                weights = [self.config.market_weights[item.market] for item in ok]
                total = math.fsum(weights)
                matrix.append([math.fsum(w * values[t] for w, values in zip(weights, series)) / total for t in range(len(series[0]))])
            return probability_of_backtest_overfitting(matrix, self.config.pbo_partitions), None
        except Exception as error:  # noqa: BLE001 - diagnostics never fail the run when catch_errors
            if not self.config.catch_errors:
                raise
            return None, f"{type(error).__name__}: {error}"


def _market_only(runner: _Runner, window: Window) -> tuple[Trial, tuple]:
    params = runner.space.defaults()
    trial = runner.run_trial(params, window, None)
    objective = runner.objective
    ok = [item for item in trial.markets if item.status == "ok"]
    ok.sort(key=lambda item: (-objective.orient(item.metrics[objective.metric]), runner.config.markets.index(item.market)))
    ranking = [MarketRank(position + 1, item.market, "ok", item.metrics[objective.metric], item.metrics)
               for position, item in enumerate(ok)]
    ranking += [MarketRank(None, item.market, "failed", None, item.metrics, item.reason)
                for item in trial.markets if item.status != "ok"]
    if runner.progress is not None:
        runner.progress(trial.index, trial if trial.status == "ok" else None)
    return trial, tuple(ranking)


def optimize(evaluate: Evaluate, space: ParameterSpace, config: OptimizerConfig, *, progress: Progress | None = None,
             returns_fn: ReturnsFn | None = None, stitch: Stitch | None = None,
             clock: Callable[[], float] = time.monotonic) -> OptimizationResult:
    """Run one optimization.

    ``returns_fn(params, window, market)`` optionally supplies per-bar returns
    for the PBO diagnostic. ``stitch`` overrides ``stitch_metrics`` for
    walk-forward. ``clock`` is injectable for tests. Limits raise
    ``OptimizerLimitError`` before any trial; ``max_trials`` and the time
    budget stop the search and set ``stop_reason``.
    """
    _require(callable(evaluate), "evaluate must be callable", TypeError)
    _require(isinstance(space, ParameterSpace), "space must be a ParameterSpace", TypeError)
    _require(isinstance(config, OptimizerConfig), "config must be an OptimizerConfig", TypeError)
    if config.method != "market_only":
        _require(bool(space.dimensions), f"Method {config.method} needs at least one dimension")
    if config.method == "grid":
        size = space.grid_size()
        _require(size <= MAX_GRID_SIZE, f"Grid size {size} exceeds limit {MAX_GRID_SIZE}", OptimizerLimitError)
    runner = _Runner(evaluate, space, config, progress, returns_fn, clock)
    validation_config = config.validation
    n = validation_config.n_observations
    best, front, ranking, stop = None, (), (), "completed"

    if config.method == "market_only":
        window = Window(0, n, "full")
        best, ranking = _market_only(runner, window)
        selected = best
        best = best if best.status == "ok" else None
        validation = ValidationResult("single", in_sample=window)
        # Picking the best of M markets is M trials of one parameter set.
        diagnostics = Diagnostics(*runner.market_dsr(selected, ranking, window),
                                  None, "market-only mode has a single parameter set")
    elif validation_config.mode == "single":
        window = Window(0, n, "full")
        trials, stop = runner.search(window, config.seed, None)
        if config.method == "pareto":
            distinct = {}
            for trial in trials:
                if trial.status == "ok":
                    distinct.setdefault(space.key(trial.params), trial)
            candidates = sorted(distinct.values(), key=lambda trial: trial.index)
            indices = pareto_front([trial.objective_values for trial in candidates], [o.direction for o in config.objectives])
            front = tuple(sorted(candidates[i].index for i in indices))
        else:
            best = runner.best(trials)
        validation = ValidationResult("single", in_sample=window)
        diagnostics = runner.diagnostics(trials, best, window)
    elif validation_config.mode == "is_oos":
        in_window, out_window = split_in_out_of_sample(n, validation_config.is_fraction)
        trials, stop = runner.search(in_window, config.seed, None)
        best = runner.best(trials)
        top = runner.distinct_ranked(trials)[:validation_config.top_k]
        reports = tuple(runner.out_of_sample(trial, out_window) for trial in top)
        validation = ValidationResult("is_oos", in_sample=in_window, out_of_sample=out_window,
                                      selected=reports[0] if reports else None, top_k=reports,
                                      reason=None if reports else "no successful in-sample trial")
        diagnostics = runner.diagnostics(trials, best, in_window)
    else:
        folds, fold_trials = [], []
        windows = walk_forward_windows(n, validation_config.train_length, validation_config.test_length,
                                       validation_config.step, validation_config.anchored)
        stop = "completed"
        for index, (train, test) in enumerate(windows):
            if runner.out_of_time():
                stop = "time_budget"
                break
            fold_seed = config.seed * 1_000_003 + index
            trials, fold_stop = runner.search(train, fold_seed, index)
            fold_trials.append(runner.distinct_ranked(trials))
            fold_best = runner.best(trials)
            report = runner.out_of_sample(fold_best, test) if fold_best is not None else None
            folds.append(FoldResult(index, train, test, fold_seed, tuple(trial.index for trial in trials), fold_stop,
                                    None if fold_best is None else fold_best.index,
                                    None if fold_best is None else dict(fold_best.params), report,
                                    runner.diagnostics(trials, fold_best, train)))
            best = fold_best
            if fold_stop == "time_budget":
                stop = "time_budget"
                break
        validation = _stitch_folds(runner, folds, stitch or stitch_metrics)
        # Every distinct trial of every fold counts; the selected trial is the last fold's choice.
        all_trials = [trial for trials_in_fold in fold_trials for trial in trials_in_fold]
        dsr, dsr_reason = runner._dsr(all_trials, best, folds[-1].train) if folds else (None, "no completed fold")
        diagnostics = Diagnostics(dsr, dsr_reason, None, "walk-forward PBO is per fold")

    timing = {"elapsed_seconds": runner.clock() - runner.started}
    recorded = config.to_dict()
    recorded["effective_max_trials"] = None if config.method == "market_only" else runner.budget()
    return OptimizationResult(config.method, config.seed, recorded, space.describe(), tuple(runner.trials), best, front,
                              validation, diagnostics, ranking, stop, runner.evaluation_count, timing)


def _stitch_folds(runner: _Runner, folds: list[FoldResult], stitch: Stitch) -> ValidationResult:
    config = runner.config
    per_market: dict[str, list] = {market: [] for market in config.markets}
    for fold in folds:
        if fold.out_of_sample is None:
            continue
        for item in fold.out_of_sample.markets:
            if item.status == "ok":
                per_market[item.market].append((fold.test, item.metrics))
    stitched = {market: dict(stitch(parts)) for market, parts in per_market.items() if parts}
    objective = runner.objective
    usable = [market for market in config.markets if market in stitched and objective.metric in stitched[market]
              and _is_number(stitched[market][objective.metric]) and math.isfinite(stitched[market][objective.metric])]
    dropped = tuple(market for market in config.markets if market not in usable)
    score = None
    if usable:
        score = robust_score([stitched[market][objective.metric] for market in usable],
                             [config.market_weights[market] for market in usable],
                             direction=objective.direction, penalty=config.dispersion_penalty)
    return ValidationResult("walk_forward", folds=tuple(folds), stitched=stitched, stitched_score=score,
                            stitched_dropped_markets=dropped, reason=None if usable else "no successful out-of-sample fold")
