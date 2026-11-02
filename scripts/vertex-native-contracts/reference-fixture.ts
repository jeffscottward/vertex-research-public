import {
  canonicalArtifactJson,
  decimalUnits,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "../../packages/shared/src/vertex/index.ts";
import {
  assertPrograms,
  MAX_DEPTH,
  MAX_PROGRAM_STEPS,
  parseStrictJson,
} from "./portable.ts";

// Test oracle only, not a production/native authority. Structural validation is
// always the authoritative source registry safeParse, not a copied shape.
const failure: (message: string) => never = (message) => {
  throw new TypeError(message);
};
const stringValue = (value: unknown): string => {
  if (typeof value !== "string") return failure("Expected string");
  return value;
};
const arrayValue = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) return failure("Expected array");
  return value;
};
const recordValue = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return failure("Expected record");
  return value as Record<string, unknown>;
};
const integerValue = (value: unknown): bigint => {
  if (typeof value === "bigint") return value;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  )
    return BigInt(value);
  return failure("Expected integer");
};
const booleanValue = (value: unknown): boolean => {
  if (typeof value !== "boolean") return failure("Expected boolean predicate");
  return value;
};
const getPath = (scope: unknown, path: string): unknown => {
  let value = scope;
  if (path === "") return value;
  for (const part of path.split(".")) {
    const record = recordValue(value);
    if (!Object.hasOwn(record, part)) return failure(`Missing field: ${part}`);
    value = record[part];
  }
  return value;
};
const equals = (left: unknown, right: unknown): boolean => {
  if (typeof left === "bigint" || typeof right === "bigint") {
    if (
      !(
        ["bigint", "number"].includes(typeof left) &&
        ["bigint", "number"].includes(typeof right)
      )
    )
      return false;
    return integerValue(left) === integerValue(right);
  }
  return canonicalArtifactJson(left) === canonicalArtifactJson(right);
};
const compare = (left: unknown, right: unknown): number => {
  if (typeof left === "string" && typeof right === "string") {
    const a = Array.from(left, (c) => c.codePointAt(0)!);
    const b = Array.from(right, (c) => c.codePointAt(0)!);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  const a = integerValue(left);
  const b = integerValue(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

export const evaluateFixtureProgram = async (
  programs: Record<string, unknown>,
  name: string,
  payload: unknown
): Promise<boolean> => {
  assertPrograms(programs);
  canonicalArtifactJson(payload);
  let steps = 0;
  const evaluate = async (
    expression: unknown,
    root: unknown,
    stack: unknown[],
    depth: number,
    iterationIndex: number | null = null
  ): Promise<unknown> => {
    if (++steps > MAX_PROGRAM_STEPS || depth > MAX_DEPTH)
      return failure("Expression resource limit");
    if (!Array.isArray(expression))
      return typeof expression === "number" ? BigInt(expression) : expression;
    const [opcode, ...operands] = expression as [string, ...unknown[]];
    const run = (value: unknown): Promise<unknown> =>
      evaluate(value, root, stack, depth + 1, iterationIndex);
    if (opcode === "lit") return operands[0];
    if (opcode === "get")
      return getPath(stack.at(-1), stringValue(operands[0]));
    if (opcode === "root") return getPath(root, stringValue(operands[0]));
    if (opcode === "index") {
      if (iterationIndex === null) return failure("No iteration index");
      return BigInt(iterationIndex);
    }
    if (opcode === "parent") {
      if (stack.length < 2) return failure("No parent scope");
      return getPath(stack.at(-2), stringValue(operands[0]));
    }
    if (opcode === "call") {
      const input = await run(operands[1]);
      return evaluate(
        programs[stringValue(operands[0])],
        input,
        [input],
        depth + 1
      );
    }
    if (opcode === "and" || opcode === "or") {
      for (const operand of operands) {
        const answer = booleanValue(await run(operand));
        if (opcode === "and" && !answer) return false;
        if (opcode === "or" && answer) return true;
      }
      return opcode === "and";
    }
    if (opcode === "if")
      return run(operands[booleanValue(await run(operands[0])) ? 1 : 2]);
    if (opcode === "not") return !booleanValue(await run(operands[0]));
    if (opcode === "every" || opcode === "some" || opcode === "sum") {
      const input = arrayValue(await run(operands[0]));
      let total = 0n;
      for (const [index, item] of input.entries()) {
        const result = await evaluate(
          operands[1],
          root,
          [...stack, item],
          depth + 1,
          index
        );
        if (opcode === "sum") {
          const integer = integerValue(result);
          total += integer;
          if (
            integer <= -(1n << 512n) ||
            integer >= 1n << 512n ||
            total <= -(1n << 512n) ||
            total >= 1n << 512n
          )
            return failure("Integer resource limit");
        } else {
          const answer = booleanValue(result);
          if (opcode === "every" && !answer) return false;
          if (opcode === "some" && answer) return true;
        }
      }
      return opcode === "sum" ? total : opcode === "every";
    }
    const values: unknown[] = [];
    for (const operand of operands) values.push(await run(operand));
    const left = values[0];
    const right = values[1];
    if (opcode === "eq") return equals(left, right);
    if (opcode === "ne") return !equals(left, right);
    if (opcode === "lt") return compare(left, right) < 0;
    if (opcode === "le") return compare(left, right) <= 0;
    if (opcode === "gt") return compare(left, right) > 0;
    if (opcode === "ge") return compare(left, right) >= 0;
    if (opcode === "add") return integerValue(left) + integerValue(right);
    if (opcode === "sub") return integerValue(left) - integerValue(right);
    if (opcode === "mul") return integerValue(left) * integerValue(right);
    if (opcode === "mod") return integerValue(left) % integerValue(right);
    if (opcode === "at") {
      const input = arrayValue(left);
      const index = integerValue(right);
      if (index < 0n || index >= BigInt(input.length))
        return failure("Index out of bounds");
      return input[Number(index)];
    }
    if (opcode === "base64Length") {
      const value = stringValue(left);
      if (
        value.length < 4 ||
        value.length > 1_398_104 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value
        )
      )
        return failure("Invalid canonical base64");
      const decoded = Buffer.from(value, "base64");
      if (
        decoded.length === 0 ||
        decoded.length > 1_048_576 ||
        decoded.toString("base64") !== value
      )
        return failure("Invalid canonical base64");
      return BigInt(decoded.length);
    }
    if (opcode === "len") {
      if (typeof left === "string") return BigInt(Array.from(left).length);
      if (Array.isArray(left)) return BigInt(left.length);
      return BigInt(Object.keys(recordValue(left)).length);
    }
    if (opcode === "concat") return values.map(stringValue).join("");
    if (opcode === "slice")
      return Array.from(stringValue(left))
        .slice(Number(integerValue(right)), Number(integerValue(values[2])))
        .join("");
    if (opcode === "decimal") return decimalUnits(stringValue(left));
    if (opcode === "integer") {
      const text = stringValue(left);
      if (!/^(0|[1-9][0-9]{0,29})$/.test(text) || text.endsWith("\n"))
        return failure("Invalid sequence");
      return BigInt(text);
    }
    if (opcode === "epoch")
      return timestampToEpochNanoseconds(stringValue(left));
    if (opcode === "timestamp") {
      try {
        timestampToEpochNanoseconds(stringValue(left));
        return true;
      } catch {
        return false;
      }
    }
    if (opcode === "unique") {
      const array = arrayValue(left);
      return new Set(array.map(canonicalArtifactJson)).size === array.length;
    }
    if (opcode === "uniqueBy") {
      const array = arrayValue(left);
      return (
        new Set(
          array.map((item) =>
            canonicalArtifactJson(getPath(item, stringValue(right)))
          )
        ).size === array.length
      );
    }
    if (opcode === "contains")
      return arrayValue(left).some((item) => equals(item, right));
    if (opcode === "keys") return Object.keys(recordValue(left)).sort(compare);
    if (opcode === "values") {
      const record = recordValue(left);
      return Object.keys(record)
        .sort(compare)
        .map((key) => record[key]);
    }
    if (opcode === "hashOmit") {
      const omitted = arrayValue(right).map(stringValue);
      const filtered = Object.fromEntries(
        Object.entries(recordValue(left)).filter(
          ([key]) => !omitted.includes(key)
        )
      );
      return hashArtifact(canonicalArtifactJson(filtered));
    }
    if (opcode === "hashOmitPaths") {
      const filtered = structuredClone(recordValue(left));
      for (const path of arrayValue(right).map(stringValue)) {
        const parts = path.split(".");
        let current = filtered;
        for (const field of parts.slice(0, -1))
          current = recordValue(getPath(current, field));
        const last = parts.at(-1)!;
        if (!Object.hasOwn(current, last))
          return failure("Missing hash omission path");
        delete current[last];
      }
      return hashArtifact(canonicalArtifactJson(filtered));
    }
    if (opcode === "nonoverlap") {
      const lower = stringValue(right);
      const upper = stringValue(values[2]);
      const array = [...arrayValue(left)].sort((a, b) =>
        compare(
          decimalUnits(stringValue(getPath(a, lower))),
          decimalUnits(stringValue(getPath(b, lower)))
        )
      );
      return array.every(
        (item, index) =>
          index === 0 ||
          decimalUnits(stringValue(getPath(array[index - 1], upper))) <=
            decimalUnits(stringValue(getPath(item, lower)))
      );
    }
    if (opcode === "publicHttps") {
      const text = stringValue(left);
      // Exact source WHATWG parsing (including recovery/IDNA forms). This is
      // source-URI syntax validation, not DNS, network-safety or rights proof.
      try {
        const uri = new URL(text);
        return (
          uri.protocol === "https:" &&
          !uri.username &&
          !uri.password &&
          !uri.search &&
          !uri.hash
        );
      } catch {
        return false;
      }
    }
    return failure(`Unsupported opcode: ${opcode}`);
  };
  if (!Object.hasOwn(programs, name))
    return failure("Missing semantic program");
  return booleanValue(await evaluate(programs[name], payload, [payload], 0));
};

// Full replay helper oracle. Only the standalone NativeOutboxReplay entrypoint
// invokes it; a nested worker transport DTO intentionally validates shapes.
export const evaluateReplayFixture = async (
  programs: Record<string, unknown>,
  payload: unknown,
  validate: (name: string, value: unknown) => Promise<boolean>
): Promise<boolean> => {
  const replay = recordValue(payload);
  if (Buffer.byteLength(canonicalArtifactJson(payload), "utf8") > 12_582_912)
    return false;
  const grant = recordValue(replay["grant"]);
  const identities = arrayValue(grant["rows"]);
  const rows = arrayValue(replay["rows"]);
  const decode = (input: unknown): Uint8Array => {
    const text = stringValue(input);
    const bytes = Buffer.from(text, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > 1_048_576 ||
      bytes.toString("base64") !== text
    )
      return failure("Invalid replay base64");
    return Uint8Array.from(bytes);
  };
  const canonical = (bytes: Uint8Array): unknown => {
    const parsed = parseStrictJson(bytes, 1_048_576);
    if (
      canonicalArtifactJson(parsed) !==
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    )
      return failure("Noncanonical replay JSON");
    return parsed;
  };
  let total = decode(grant["approvalBase64"]).length;
  if (replay["retainedEpochTransitionBase64"] !== null) {
    const bytes = decode(replay["retainedEpochTransitionBase64"]);
    total += bytes.length;
    if (
      total > 8_388_608 ||
      (await hashArtifact(bytes)) !== grant["retainedEpochTransitionSha256"]
    )
      return false;
    const transition = canonical(bytes);
    if (!(await validate("PortfolioEpochTransition", transition))) return false;
    if (
      !(await evaluateFixtureProgram(
        programs,
        "NativeReplayRetainedTransitionBinding",
        { grant, transition }
      ))
    )
      return false;
    const first = recordValue(rows[0]);
    if (first["kind"] !== "portfolio-genesis") return false;
    const snapshotText = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(decode(first["projectionBase64"]));
    if (
      canonicalArtifactJson(recordValue(transition)["snapshot"]) !==
      snapshotText
    )
      return false;
  }
  let priorHash = grant["startingEventHash"];
  for (const [index, entry] of rows.entries()) {
    const row = recordValue(entry);
    const identity = recordValue(identities[index]);
    const bytes = decode(row["projectionBase64"]);
    const proofBytes =
      row["proofBase64"] === null ? null : decode(row["proofBase64"]);
    total += bytes.length + (proofBytes?.length ?? 0);
    if (
      total > 8_388_608 ||
      (await hashArtifact(bytes)) !== identity["projectionRawSha256"]
    )
      return false;
    const value = canonical(bytes);
    const kind = stringValue(row["kind"]);
    const contract = (
      {
        "portfolio-genesis": "PortfolioGenesis",
        "portfolio-snapshot": "PortfolioSnapshot",
        order: "ExecutionProjection",
        "native-fact": "NativeFactProjection",
      } as Record<string, string>
    )[kind];
    if (!(contract && (await validate(contract, value)))) return false;
    if (
      !(await evaluateFixtureProgram(programs, "NativeReplayRowBinding", {
        grant,
        identity,
        value,
        priorHash,
      }))
    )
      return false;
    if (kind === "native-fact") {
      if (
        proofBytes === null ||
        (await hashArtifact(proofBytes)) !== identity["proofSha256"]
      )
        return false;
      const projection = recordValue(value);
      if (
        (await hashArtifact(proofBytes)) !==
        recordValue(projection["proof"])["sha256"]
      )
        return false;
      const proof = canonical(proofBytes);
      if (
        !(
          (await validate("NativeJournalProof", proof)) &&
          (await evaluateFixtureProgram(programs, "NativeJournalProofBinding", {
            projection,
            proof,
          }))
        )
      )
        return false;
    }
    if (kind !== "portfolio-snapshot") priorHash = identity["eventHash"];
  }
  return true;
};
