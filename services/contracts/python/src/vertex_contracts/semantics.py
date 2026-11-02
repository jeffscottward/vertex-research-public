"""Finite expression IR, not an executable scripting language.

The caller pins the complete bundle. Programs can inspect only the supplied
JSON artifact; there are no imports, environment, clocks, I/O or custom calls.
"""

from .codec import (ContractError, ContractUnavailable, MAX_DEPTH, MAX_NODES,
                    MAX_STRING_BYTES, canonical_encode, decimal_units, epoch_ns,
                    rawSHA256, sequence_integer)
from .schema import public_https
from .binary import decode_canonical_base64

_ARITIES = {
    "lit": (1, 1), "get": (1, 1), "root": (1, 1), "parent": (1, 1),
    "call": (2, 2), "and": (1, 512), "or": (1, 512), "not": (1, 1),
    "if": (3, 3), "eq": (2, 2), "ne": (2, 2), "lt": (2, 2),
    "le": (2, 2), "gt": (2, 2), "ge": (2, 2), "add": (2, 2),
    "sub": (2, 2), "mod": (2, 2), "mul": (2, 2), "len": (1, 1),
    "concat": (1, 512), "slice": (3, 3), "decimal": (1, 1), "epoch": (1, 1),
    "integer": (1, 1), "unique": (1, 1), "uniqueBy": (2, 2),
    "every": (2, 2), "some": (2, 2), "contains": (2, 2), "keys": (1, 1),
    "values": (1, 1), "hashOmit": (2, 2), "nonoverlap": (3, 3),
    "hashOmitPaths": (2, 2),
    "publicHttps": (1, 1), "timestamp": (1, 1),
    "base64Length": (1, 1), "sum": (2, 2), "at": (2, 2), "index": (0, 0),
}


def _boolean(value):
    if type(value) is not bool:
        raise ContractError("Semantic condition must be boolean")
    return value


def _integer(value):
    if type(value) is not int or value.bit_length() > 512:
        raise ContractError("Semantic integer type or size rejected")
    return value


def _string(value):
    if type(value) is not str or len(value.encode("utf-8")) > MAX_STRING_BYTES:
        raise ContractError("Semantic string type or size rejected")
    return value


def _array(value):
    if type(value) is not list or len(value) > MAX_NODES:
        raise ContractError("Semantic collection type or size rejected")
    return value


def _record(value):
    if type(value) is not dict or len(value) > MAX_NODES:
        raise ContractError("Semantic object type or size rejected")
    return value


def _get(value, path):
    if type(path) is not str or len(path) > 2048:
        raise ContractError("Semantic path rejected")
    if path == "":
        return value
    for part in path.split("."):
        if type(value) is not dict or part not in value:
            raise ContractError("Missing semantic field")
        value = value[part]
    return value


def _equal(left, right):
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(_equal(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(_equal(a, b) for a, b in zip(left, right))
    return left == right


class SemanticPrograms:
    def __init__(self, programs):
        if type(programs) is not dict or not programs or len(programs) > 512:
            raise ContractUnavailable("Missing or unbounded semantic programs")
        self.programs = programs
        dependencies: dict[str, set[str]] = {name: set() for name in programs}
        nodes = [0]

        def inspect(expression, rule, depth, lexical_depth=0):
            nodes[0] += 1
            if depth > MAX_DEPTH or nodes[0] > MAX_NODES:
                raise ContractUnavailable("Semantic program graph budget exceeded")
            if type(expression) is not list:
                if expression is not None and type(expression) not in (bool, int, str):
                    raise ContractUnavailable("Object expressions must be explicit literals")
                return
            if not expression or type(expression[0]) is not str or expression[0] not in _ARITIES:
                raise ContractUnavailable("Unsupported semantic opcode")
            op, *args = expression
            low, high = _ARITIES[op]
            if not low <= len(args) <= high:
                raise ContractUnavailable("Unsupported semantic arity")
            if op == "index":
                if lexical_depth == 0:
                    raise ContractUnavailable("Index requires a lexical collection scope")
                return
            if op == "lit":
                canonical_encode(args[0])
                return
            if op in ("get", "root", "parent"):
                if type(args[0]) is not str or len(args[0]) > 2048:
                    raise ContractUnavailable("Invalid semantic path")
                if args[0] and (len(args[0].split(".")) > MAX_DEPTH or any(not part for part in args[0].split("."))):
                    raise ContractUnavailable("Invalid semantic path segments")
                if op == "parent" and lexical_depth == 0:
                    raise ContractUnavailable("Parent requires a lexical collection scope")
                return
            if op == "call":
                if type(args[0]) is not str or args[0] not in programs:
                    raise ContractUnavailable("Unavailable semantic rule")
                dependencies[rule].add(args[0])
                inspect(args[1], rule, depth + 1, lexical_depth)
                return
            if op == "hashOmitPaths" and args[1] != ["lit", ["sourceEventHash", "continuity.highWaterEventHash"]]:
                raise ContractUnavailable("Only the frozen portfolio genesis hash omissions are supported")
            if op in ("every", "some", "sum"):
                inspect(args[0], rule, depth + 1, lexical_depth)
                inspect(args[1], rule, depth + 1, lexical_depth + 1)
                return
            if op in ("uniqueBy", "nonoverlap"):
                fields = args[1:] if op == "nonoverlap" else [args[1]]
                if any(type(field) is not str or not field or len(field) > 2048 for field in fields):
                    raise ContractUnavailable("Collection field selectors must be literal paths")
            if op == "hashOmit":
                literal = args[1]
                if type(literal) is not list or len(literal) != 2 or literal[0] != "lit" or type(literal[1]) is not list:
                    raise ContractUnavailable("Hash omissions must be a literal field list")
                fields = literal[1]
                if any(type(field) is not str or not field for field in fields) or len(set(fields)) != len(fields):
                    raise ContractUnavailable("Hash omissions must be unique nonempty strings")
            for argument in args:
                inspect(argument, rule, depth + 1, lexical_depth)

        for name, program in programs.items():
            if type(name) is not str or not name or len(name) > 160:
                raise ContractUnavailable("Invalid semantic rule name")
            inspect(program, name, 0)
        visited = set()
        active = set()

        def acyclic(name, depth):
            if name in active or depth > MAX_DEPTH:
                raise ContractUnavailable("Recursive semantic programs are unsupported")
            if name in visited:
                return
            active.add(name)
            for dependency in dependencies[name]:
                acyclic(dependency, depth + 1)
            active.remove(name)
            visited.add(name)

        for name in programs:
            acyclic(name, 0)

    def validate(self, rule: str, value):
        if rule not in self.programs:
            raise ContractUnavailable("Contract semantics unavailable")
        steps = [0]

        def charge(amount=1):
            steps[0] += amount
            if steps[0] > 16_000_000:
                raise ContractError("Semantic instruction budget exceeded")

        def evaluate(expression, root, scopes, depth, indices=()):
            charge()
            if depth > MAX_DEPTH:
                raise ContractError("Semantic recursion budget exceeded")
            if type(expression) is not list:
                return expression
            op, *args = expression

            def ev(child):
                return evaluate(child, root, scopes, depth + 1, indices)

            if op == "lit":
                return args[0]
            if op == "index":
                if not indices:
                    raise ContractError("No lexical collection index")
                return indices[-1]
            if op in ("get", "root", "parent"):
                if op == "parent" and len(scopes) < 2:
                    raise ContractError("No lexical parent")
                source = root if op == "root" else scopes[-2] if op == "parent" else scopes[-1]
                return _get(source, args[0])
            if op == "call":
                supplied = ev(args[1])
                return evaluate(self.programs[args[0]], supplied, [supplied], depth + 1)
            if op == "and":
                return all(_boolean(ev(argument)) for argument in args)
            if op == "or":
                return any(_boolean(ev(argument)) for argument in args)
            if op == "not":
                return not _boolean(ev(args[0]))
            if op == "if":
                return ev(args[1] if _boolean(ev(args[0])) else args[2])
            if op in ("every", "some", "sum"):
                collection = _array(ev(args[0]))
                charge(len(collection))
                items = (evaluate(args[1], root, [*scopes, item], depth + 1, (*indices, index))
                         for index, item in enumerate(collection))
                if op == "sum":
                    total = 0
                    for item in items:
                        total = _integer(total + _integer(item))
                    return total
                conditions = (_boolean(item) for item in items)
                return all(conditions) if op == "every" else any(conditions)
            values = [ev(argument) for argument in args]
            if op == "base64Length":
                encoded = _string(values[0])
                charge((len(encoded) + 1023) // 1024)
                return len(decode_canonical_base64(encoded))
            if op == "at":
                array, index = _array(values[0]), _integer(values[1])
                if index < 0 or index >= len(array):
                    raise ContractError("Collection index is out of bounds")
                return array[index]
            if op in ("eq", "ne"):
                equal = _equal(values[0], values[1])
                return equal if op == "eq" else not equal
            if op in ("lt", "le", "gt", "ge"):
                left, right = values
                if type(left) is not type(right) or type(left) not in (str, int):
                    raise ContractError("Semantic comparison requires matching scalar types")
                if op == "lt":
                    return left < right
                if op == "le":
                    return left <= right
                if op == "gt":
                    return left > right
                return left >= right
            if op in ("add", "sub", "mul", "mod"):
                left, right = map(_integer, values)
                if op == "add":
                    result = left + right
                elif op == "sub":
                    result = left - right
                elif op == "mul":
                    result = left * right
                else:
                    if right == 0:
                        raise ContractError("Semantic division by zero")
                    # JavaScript bigint remainder is truncated toward zero.
                    result = abs(left) % abs(right)
                    if left < 0:
                        result = -result
                return _integer(result)
            if op == "len":
                item = values[0]
                if type(item) not in (str, list, dict):
                    raise ContractError("Semantic length requires collection or string")
                return len(item.encode("utf-16-le")) // 2 if type(item) is str else len(item)
            if op == "concat":
                return _string("".join(_string(item) for item in values))
            if op == "slice":
                text = _string(values[0]).encode("utf-16-le")
                length = len(text) // 2
                start, end = _integer(values[1]), _integer(values[2])
                start = max(length + start, 0) if start < 0 else min(start, length)
                end = max(length + end, 0) if end < 0 else min(end, length)
                try:
                    return text[start * 2:max(start, end) * 2].decode("utf-16-le", "strict")
                except UnicodeError as exc:
                    raise ContractError("Semantic slice splits Unicode scalar") from exc
            if op == "decimal":
                return decimal_units(values[0])
            if op == "epoch":
                return epoch_ns(values[0])
            if op == "integer":
                return sequence_integer(values[0])
            if op == "timestamp":
                try:
                    epoch_ns(values[0])
                    return True
                except ContractError:
                    return False
            if op == "publicHttps":
                return public_https(values[0])
            if op in ("unique", "uniqueBy"):
                collection = _array(values[0])
                charge(len(collection))
                if op == "uniqueBy":
                    collection = [_get(item, _string(values[1])) for item in collection]
                return len({canonical_encode(item) for item in collection}) == len(collection)
            if op == "contains":
                collection = _array(values[0])
                charge(len(collection))
                return any(_equal(item, values[1]) for item in collection)
            if op in ("keys", "values"):
                record = _record(values[0])
                charge(len(record))
                return sorted(record) if op == "keys" else [record[key] for key in sorted(record)]
            if op == "hashOmit":
                record, omitted = _record(values[0]), _array(values[1])
                if any(type(key) is not str for key in omitted) or len(set(omitted)) != len(omitted):
                    raise ContractError("Invalid omitted hash keys")
                if any(key not in record for key in omitted):
                    raise ContractError("Missing omitted hash key")
                return rawSHA256(canonical_encode({key: child for key, child in record.items() if key not in omitted}))
            if op == "hashOmitPaths":
                record, paths = _record(values[0]), _array(values[1])
                if not 1 <= len(paths) <= 64:
                    raise ContractError("Nested hash omission budget exceeded")
                parts = []
                for path in paths:
                    if type(path) is not str or not 1 <= len(path) <= 2048:
                        raise ContractError("Invalid nested hash omission path")
                    segments = path.split(".")
                    if len(segments) > MAX_DEPTH or any(not segment for segment in segments):
                        raise ContractError("Invalid nested hash omission path")
                    parts.append(segments)
                ordered = sorted(parts)
                if any(right[:len(left)] == left for left, right in zip(ordered, ordered[1:])):
                    raise ContractError("Duplicate or overlapping nested hash omissions")

                def without(node, segments):
                    copied = dict(_record(node))
                    charge(len(copied))
                    key = segments[0]
                    if key not in copied:
                        raise ContractError("Missing nested hash omission field")
                    if len(segments) == 1:
                        del copied[key]
                    else:
                        copied[key] = without(copied[key], segments[1:])
                    return copied

                result = record
                for segments in parts:
                    result = without(result, segments)
                return rawSHA256(canonical_encode(result))
            if op == "nonoverlap":
                collection = _array(values[0])
                charge(len(collection) * 2)
                lower, upper = _string(values[1]), _string(values[2])
                pairs = sorted((decimal_units(_get(item, lower)), decimal_units(_get(item, upper))) for item in collection)
                return all(previous[1] <= current[0] for previous, current in zip(pairs, pairs[1:]))
            raise ContractUnavailable("Unsupported semantic opcode")

        if evaluate(self.programs[rule], value, [value], 0) is not True:
            raise ContractError("Semantic contract validation rejected input")
