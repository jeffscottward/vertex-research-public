use crate::canonical::{self, Budget, MAX_DEPTH, MAX_NODES, STRING_BYTES};
use crate::exact;
use crate::{ContractError, Result};
use num_bigint::BigInt;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

pub(crate) struct Programs { expressions: BTreeMap<String, Value> }

#[derive(PartialEq, Eq)]
struct Data { kind: Kind, weight: usize }
type Node = Arc<Data>;
#[derive(PartialEq, Eq)]
enum Kind {
    Null, Bool(bool), Integer(BigInt), String(String),
    Array(Vec<Node>), Object(BTreeMap<String, Node>),
}
fn semantic(message: &str) -> ContractError { ContractError::Semantic(message.into()) }
fn unavailable(message: &str) -> ContractError { ContractError::Unavailable(message.into()) }
fn node(kind: Kind) -> Node {
    let weight = match &kind {
        Kind::Null | Kind::Bool(_) => 1,
        Kind::Integer(n) => 1 + (n.bits() as usize / 8),
        Kind::String(s) => 1 + s.len(),
        Kind::Array(a) => 1 + a.iter().map(|n| n.weight).sum::<usize>(),
        Kind::Object(o) => 1 + o.iter().map(|(k, n)| k.len() + n.weight).sum::<usize>(),
    };
    Arc::new(Data { kind, weight })
}
fn boolean(value: bool) -> Node { node(Kind::Bool(value)) }
fn bigint(value: BigInt) -> Result<Node> {
    // Arithmetic is unbounded by the JSON safe-integer limit. Physical resource
    // ceilings still apply, including to products that grow exponentially.
    if value.bits() > 512 { return Err(ContractError::Limit("expression integer bits")); }
    Ok(node(Kind::Integer(value)))
}
fn string(value: String) -> Result<Node> {
    if value.len() > STRING_BYTES { return Err(ContractError::Limit("expression string bytes")); }
    Ok(node(Kind::String(value)))
}
fn from_json(value: &Value, budget: &mut Budget) -> Result<Node> {
    budget.spend(1)?;
    Ok(match value {
        Value::Null => node(Kind::Null), Value::Bool(b) => boolean(*b),
        Value::Number(n) => bigint(BigInt::from(n.as_i64().ok_or_else(|| semantic("unsafe input integer"))?))?,
        Value::String(s) => { budget.spend(s.len().div_ceil(1024))?; string(s.clone())? }
        Value::Array(a) => node(Kind::Array(a.iter().map(|v| from_json(v, budget)).collect::<Result<_>>()?)),
        Value::Object(o) => node(Kind::Object(o.iter().map(|(k, v)| Ok((k.clone(), from_json(v, budget)?))).collect::<Result<_>>()?)),
    })
}
fn to_json(value: &Node, budget: &mut Budget) -> Result<Value> {
    budget.spend(1)?;
    Ok(match &value.kind {
        Kind::Null => Value::Null, Kind::Bool(b) => Value::Bool(*b),
        Kind::Integer(n) => {
            let integer: i64 = n.try_into().map_err(|_| semantic("integer outside JSON boundary"))?;
            if !(-canonical::SAFE..=canonical::SAFE).contains(&integer) { return Err(semantic("integer outside JSON boundary")); }
            Value::from(integer)
        }
        Kind::String(s) => { budget.spend(s.len().div_ceil(1024))?; Value::String(s.clone()) }
        Kind::Array(a) => Value::Array(a.iter().map(|n| to_json(n, budget)).collect::<Result<_>>()?),
        Kind::Object(o) => Value::Object(o.iter().map(|(k, n)| Ok((k.clone(), to_json(n, budget)?))).collect::<Result<_>>()?),
    })
}
fn as_bool(value: &Node) -> Result<bool> { if let Kind::Bool(b) = &value.kind { Ok(*b) } else { Err(semantic("boolean operand required")) } }
fn as_str(value: &Node) -> Result<&str> { if let Kind::String(s) = &value.kind { Ok(s) } else { Err(semantic("string operand required")) } }
fn as_int(value: &Node) -> Result<&BigInt> { if let Kind::Integer(n) = &value.kind { Ok(n) } else { Err(semantic("integer operand required")) } }
fn as_array(value: &Node) -> Result<&[Node]> { if let Kind::Array(a) = &value.kind { Ok(a) } else { Err(semantic("array operand required")) } }
fn as_object(value: &Node) -> Result<&BTreeMap<String, Node>> { if let Kind::Object(o) = &value.kind { Ok(o) } else { Err(semantic("object operand required")) } }
fn text(value: &Value) -> Result<&str> { value.as_str().ok_or_else(|| unavailable("opcode string operand required")) }
fn valid_path(path: &str) -> bool { path.is_empty() || path.split('.').all(|s| !s.is_empty()) }
fn get(value: &Node, path: &str, budget: &mut Budget) -> Result<Node> {
    let mut current = value.clone();
    if path.is_empty() { return Ok(current); }
    for field in path.split('.') {
        budget.spend(1)?;
        current = as_object(&current)?.get(field).cloned().ok_or_else(|| semantic("missing field path"))?;
    }
    Ok(current)
}
fn equality(a: &Node, b: &Node, budget: &mut Budget) -> Result<bool> {
    budget.spend(a.weight.saturating_add(b.weight))?;
    Ok(a == b)
}
fn canonical_key(value: &Node, budget: &mut Budget) -> Result<Vec<u8>> {
    let value = to_json(value, budget)?;
    let encoded = canonical::encode(&value, canonical::PAYLOAD_BYTES)?;
    budget.spend(encoded.len())?;
    Ok(encoded)
}

fn omission_paths(paths: &BTreeSet<&str>, budget: &mut Budget) -> Result<()> {
    if paths.is_empty() || paths.len() > 64 { return Err(unavailable("hash omission path count")); }
    for path in paths {
        if path.is_empty() || path.chars().count() > 2048 || !valid_path(path) || path.split('.').count() > MAX_DEPTH {
            return Err(unavailable("invalid hash omission path"));
        }
        let mut ancestor = String::new();
        let mut segments = path.split('.').peekable();
        while let Some(segment) = segments.next() {
            budget.spend(1)?;
            if !ancestor.is_empty() { ancestor.push('.'); }
            ancestor.push_str(segment);
            if segments.peek().is_some() && paths.contains(ancestor.as_str()) {
                return Err(unavailable("overlapping hash omission paths"));
            }
        }
    }
    Ok(())
}

fn omit_path(value: &Node, segments: &[&str], budget: &mut Budget) -> Result<Node> {
    let original = as_object(value)?;
    let key = segments.first().ok_or_else(|| semantic("empty hash omission path"))?;
    let child = original.get(*key).ok_or_else(|| semantic("missing hash omission path"))?;
    budget.spend(original.len().saturating_add(original.keys().map(String::len).sum::<usize>()))?;
    // Copy only maps on this finite path. Shared Arc children are immutable;
    // neither rule scope nor eventual ValidatedArtifact can be normalized.
    let mut copy = original.clone();
    if segments.len() == 1 { copy.remove(*key); }
    else { copy.insert((*key).to_string(), omit_path(child, &segments[1..], budget)?); }
    Ok(node(Kind::Object(copy)))
}

impl Programs {
    pub(crate) fn compile(expressions: BTreeMap<String, Value>, budget: &mut Budget) -> Result<Self> {
        if expressions.is_empty() { return Err(unavailable("empty semantic program registry")); }
        let mut graph = BTreeMap::new();
        let mut nodes = 0;
        for (name, expr) in &expressions {
            if name.is_empty() { return Err(unavailable("empty rule name")); }
            let mut calls = BTreeSet::new();
            Self::audit(expr, &expressions, &mut calls, budget, &mut nodes, 0)?;
            graph.insert(name.as_str(), calls);
        }
        let mut finished = BTreeSet::new();
        for name in expressions.keys() {
            Self::acyclic(name, &graph, &mut BTreeSet::new(), &mut finished, budget, 0)?;
        }
        Ok(Self { expressions })
    }

    fn acyclic<'a>(name: &'a str, graph: &BTreeMap<&'a str, BTreeSet<&'a str>>, active: &mut BTreeSet<&'a str>, finished: &mut BTreeSet<&'a str>, budget: &mut Budget, depth: usize) -> Result<()> {
        budget.spend(1)?;
        if depth > MAX_DEPTH || !active.insert(name) { return Err(unavailable("recursive semantic calls")); }
        if !finished.contains(name) {
            for next in graph.get(name).ok_or_else(|| unavailable("missing semantic rule"))? {
                Self::acyclic(next, graph, active, finished, budget, depth + 1)?;
            }
            finished.insert(name);
        }
        active.remove(name);
        Ok(())
    }

    fn audit<'a>(expr: &'a Value, programs: &'a BTreeMap<String, Value>, calls: &mut BTreeSet<&'a str>, budget: &mut Budget, nodes: &mut usize, depth: usize) -> Result<()> {
        budget.spend(1)?;
        *nodes += 1;
        if depth > MAX_DEPTH || *nodes > MAX_NODES { return Err(ContractError::Limit("program AST")); }
        if !expr.is_array() {
            if expr.is_object() { return Err(unavailable("complex expression literals require lit")); }
            return Ok(());
        }
        let a = expr.as_array().ok_or_else(|| unavailable("expression array"))?;
        let op = a.first().and_then(Value::as_str).ok_or_else(|| unavailable("missing opcode"))?;
        let count = a.len() - 1;
        let correct = match op {
            "and" | "or" | "concat" => true,
            "index" => count == 0,
            "lit" | "get" | "root" | "parent" | "not" | "len" | "decimal" | "epoch" | "integer" | "unique" | "keys" | "values" | "publicHttps" | "timestamp" | "base64Length" => count == 1,
            "call" | "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "add" | "sub" | "mod" | "mul" | "uniqueBy" | "every" | "some" | "contains" | "hashOmit" | "hashOmitPaths" | "at" | "sum" => count == 2,
            "if" | "slice" | "nonoverlap" => count == 3,
            _ => return Err(ContractError::Unavailable(format!("unsupported opcode: {op}"))),
        };
        if !correct { return Err(unavailable("invalid opcode arity")); }
        let mut children: Vec<&Value> = a[1..].iter().collect();
        match op {
            "lit" => children.clear(),
            "get" | "root" | "parent" => {
                if !valid_path(text(&a[1])?) { return Err(unavailable("invalid field path")); }
                children.clear();
            }
            "call" => {
                let name = text(&a[1])?;
                if !programs.contains_key(name) { return Err(unavailable("missing called program")); }
                calls.insert(name);
                children.remove(0);
            }
            "uniqueBy" => { if !valid_path(text(&a[2])?) { return Err(unavailable("invalid uniqueBy path")); } children.pop(); }
            "nonoverlap" => {
                if !valid_path(text(&a[2])?) || !valid_path(text(&a[3])?) { return Err(unavailable("invalid nonoverlap path")); }
                children.truncate(1);
            }
            "hashOmit" | "hashOmitPaths" => {
                let literal = a[2].as_array().filter(|v| v.len() == 2 && v[0].as_str() == Some("lit"))
                    .and_then(|v| v[1].as_array()).ok_or_else(|| unavailable("hashOmit requires lit field list"))?;
                let mut seen = BTreeSet::new();
                for field in literal { if !seen.insert(text(field)?) { return Err(unavailable("duplicate hash omission")); } }
                if op == "hashOmitPaths" {
                    // This profile grants exactly the two genesis commitments,
                    // in source-declared order; it is not arbitrary redaction.
                    if literal.len() != 2 || literal[0].as_str() != Some("sourceEventHash")
                        || literal[1].as_str() != Some("continuity.highWaterEventHash") {
                        return Err(unavailable("hashOmitPaths outside declared genesis omissions"));
                    }
                    omission_paths(&seen, budget)?;
                }
            }
            _ => {}
        }
        for child in children { Self::audit(child, programs, calls, budget, nodes, depth + 1)?; }
        Ok(())
    }

    pub(crate) fn contains(&self, rule: &str) -> bool { self.expressions.contains_key(rule) }

    pub(crate) fn validate(&self, rule: &str, value: &Value, budget: &mut Budget) -> Result<bool> {
        let value = from_json(value, budget)?;
        let expr = self.expressions.get(rule).ok_or_else(|| unavailable("missing contract program"))?;
        as_bool(&self.eval(expr, &value, &[value.clone()], None, budget, 0)?)
    }

    fn eval(&self, expr: &Value, root: &Node, scopes: &[Node], index: Option<usize>, budget: &mut Budget, depth: usize) -> Result<Node> {
        budget.spend(1)?;
        if depth > MAX_DEPTH { return Err(ContractError::Limit("expression evaluation depth")); }
        let a = match expr.as_array() { Some(a) => a, None => return from_json(expr, budget) };
        let op = text(&a[0])?;
        let eval = |e: &Value, budget: &mut Budget| self.eval(e, root, scopes, index, budget, depth + 1);
        let current = scopes.last().ok_or_else(|| semantic("missing current scope"))?;
        match op {
            "lit" => from_json(&a[1], budget),
            "get" => get(current, text(&a[1])?, budget),
            "root" => get(root, text(&a[1])?, budget),
            "parent" => get(scopes.get(scopes.len().checked_sub(2).ok_or_else(|| semantic("parent scope unavailable"))?)
                .ok_or_else(|| semantic("parent scope unavailable"))?, text(&a[1])?, budget),
            "call" => {
                let value = eval(&a[2], budget)?;
                let called = self.expressions.get(text(&a[1])?).ok_or_else(|| unavailable("missing called program"))?;
                self.eval(called, &value, &[value.clone()], None, budget, depth + 1)
            }
            "index" => bigint(BigInt::from(index.ok_or_else(|| semantic("iteration index unavailable"))?)),
            "at" => {
                let value = eval(&a[1], budget)?;
                let position = eval(&a[2], budget)?;
                let index = usize::try_from(as_int(&position)?).map_err(|_| semantic("array index out of range"))?;
                as_array(&value)?.get(index).cloned().ok_or_else(|| semantic("array index out of range"))
            }
            "base64Length" => {
                let value = eval(&a[1], budget)?;
                let text = as_str(&value)?;
                budget.spend(text.len().div_ceil(1024))?;
                bigint(BigInt::from(exact::base64_bytes(text)?.len()))
            }
            "and" | "or" => {
                for child in &a[1..] {
                    let value = as_bool(&eval(child, budget)?)?;
                    if op == "and" && !value { return Ok(boolean(false)); }
                    if op == "or" && value { return Ok(boolean(true)); }
                }
                Ok(boolean(op == "and"))
            }
            "not" => Ok(boolean(!as_bool(&eval(&a[1], budget)?)?)),
            "if" => {
                let branch = if as_bool(&eval(&a[1], budget)?)? { 2 } else { 3 };
                eval(&a[branch], budget)
            }
            "eq" | "ne" => {
                let left = eval(&a[1], budget)?;
                let right = eval(&a[2], budget)?;
                Ok(boolean(equality(&left, &right, budget)? == (op == "eq")))
            }
            "lt" | "le" | "gt" | "ge" => {
                let left = eval(&a[1], budget)?;
                let right = eval(&a[2], budget)?;
                budget.spend(left.weight.saturating_add(right.weight))?;
                let ordering = match (&left.kind, &right.kind) {
                    (Kind::Integer(a), Kind::Integer(b)) => a.cmp(b),
                    (Kind::String(a), Kind::String(b)) => a.cmp(b),
                    _ => return Err(semantic("ordering requires same typed integers or strings")),
                };
                Ok(boolean(match op { "lt" => ordering.is_lt(), "le" => !ordering.is_gt(), "gt" => ordering.is_gt(), _ => !ordering.is_lt() }))
            }
            "add" | "sub" | "mod" | "mul" => {
                let left = eval(&a[1], budget)?;
                let right = eval(&a[2], budget)?;
                let left = as_int(&left)?;
                let right = as_int(&right)?;
                let l = 1 + left.bits() as usize / 64;
                let r = 1 + right.bits() as usize / 64;
                budget.spend(if matches!(op, "mul" | "mod") { l.saturating_mul(r) } else { l.saturating_add(r) })?;
                if op == "mul" && left.bits().saturating_add(right.bits()) > 513 { return Err(ContractError::Limit("expression integer product")); }
                bigint(match op {
                    "add" => left + right, "sub" => left - right, "mul" => left * right,
                    _ => { if right == &BigInt::from(0) { return Err(semantic("modulo by zero")); } left % right }
                })
            }
            "len" => {
                let value = eval(&a[1], budget)?;
                let length = match &value.kind {
                    Kind::String(s) => { budget.spend(s.len())?; s.encode_utf16().count() }
                    Kind::Array(a) => a.len(), Kind::Object(o) => o.len(), _ => return Err(semantic("len operand")),
                };
                bigint(BigInt::from(length))
            }
            "concat" => {
                let mut output = String::new();
                for child in &a[1..] {
                    let value = eval(child, budget)?;
                    let s = as_str(&value)?;
                    budget.spend(s.len())?;
                    if output.len().saturating_add(s.len()) > STRING_BYTES { return Err(ContractError::Limit("concat string")); }
                    output.push_str(s);
                }
                string(output)
            }
            "slice" => {
                let value = eval(&a[1], budget)?;
                let start = eval(&a[2], budget)?;
                let end = eval(&a[3], budget)?;
                let s = as_str(&value)?;
                budget.spend(s.len())?;
                let units: Vec<_> = s.encode_utf16().collect();
                let index = |n: &BigInt| -> usize {
                    let length = BigInt::from(units.len());
                    let n = if n < &BigInt::from(0) { &length + n } else { n.clone() };
                    if n <= BigInt::from(0) { 0 } else if n >= length { units.len() } else { usize::try_from(n).unwrap_or(units.len()) }
                };
                let start = index(as_int(&start)?);
                let end = index(as_int(&end)?).max(start);
                string(String::from_utf16(&units[start..end]).map_err(|_| semantic("slice splits Unicode scalar"))?)
            }
            "decimal" | "epoch" | "integer" => {
                let value = eval(&a[1], budget)?;
                let text = as_str(&value)?;
                budget.spend(text.len())?;
                bigint(match op { "decimal" => exact::decimal(text)?, "epoch" => BigInt::from(exact::epoch_ns(text)?), _ => exact::integer(text)? })
            }
            "timestamp" | "publicHttps" => {
                let value = eval(&a[1], budget)?;
                let text = as_str(&value)?;
                budget.spend(text.len())?;
                Ok(boolean(if op == "timestamp" { exact::epoch_ns(text).is_ok() } else { exact::public_https(text) }))
            }
            "every" | "some" | "sum" => {
                let value = eval(&a[1], budget)?;
                let values = as_array(&value)?;
                let mut nested = scopes.to_vec();
                let mut total = BigInt::from(0);
                for (index, item) in values.iter().enumerate() {
                    nested.push(item.clone());
                    let result = self.eval(&a[2], root, &nested, Some(index), budget, depth + 1)?;
                    nested.pop();
                    if op == "sum" {
                        let number = as_int(&result)?;
                        budget.spend(1 + (total.bits() as usize + number.bits() as usize) / 64)?;
                        total += number;
                        if total.bits() > 512 { return Err(ContractError::Limit("sum integer bits")); }
                    } else {
                        let accepted = as_bool(&result)?;
                        if op == "every" && !accepted { return Ok(boolean(false)); }
                        if op == "some" && accepted { return Ok(boolean(true)); }
                    }
                }
                if op == "sum" { bigint(total) } else { Ok(boolean(op == "every")) }
            }
            "contains" => {
                let value = eval(&a[1], budget)?;
                let target = eval(&a[2], budget)?;
                for item in as_array(&value)? { if equality(item, &target, budget)? { return Ok(boolean(true)); } }
                Ok(boolean(false))
            }
            "unique" | "uniqueBy" => {
                let value = eval(&a[1], budget)?;
                let mut keys = BTreeSet::new();
                for item in as_array(&value)? {
                    let key = if op == "uniqueBy" { get(item, text(&a[2])?, budget)? } else { item.clone() };
                    if !keys.insert(canonical_key(&key, budget)?) { return Ok(boolean(false)); }
                }
                Ok(boolean(true))
            }
            "keys" | "values" => {
                let value = eval(&a[1], budget)?;
                let o = as_object(&value)?;
                budget.spend(o.len())?;
                let values = if op == "keys" { o.keys().map(|k| string(k.clone())).collect::<Result<_>>()? } else { o.values().cloned().collect() };
                Ok(node(Kind::Array(values)))
            }
            "hashOmit" => {
                let value = eval(&a[1], budget)?;
                let omissions = eval(&a[2], budget)?;
                let fields: BTreeSet<&str> = as_array(&omissions)?.iter().map(as_str).collect::<Result<_>>()?;
                let o = as_object(&value)?;
                if fields.len() != as_array(&omissions)?.len() || fields.iter().any(|field| !o.contains_key(*field)) {
                    return Err(semantic("hashOmit requires distinct existing fields"));
                }
                budget.spend(o.len())?;
                let filtered = node(Kind::Object(o.iter().filter(|(k, _)| !fields.contains(k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()));
                string(canonical::sha256(&canonical_key(&filtered, budget)?))
            }
            "hashOmitPaths" => {
                let mut value = eval(&a[1], budget)?;
                as_object(&value)?;
                let omissions = eval(&a[2], budget)?;
                let fields: BTreeSet<&str> = as_array(&omissions)?.iter().map(as_str).collect::<Result<_>>()?;
                if fields.len() != as_array(&omissions)?.len() { return Err(semantic("duplicate hash omission path")); }
                omission_paths(&fields, budget)?;
                for path in fields {
                    value = omit_path(&value, &path.split('.').collect::<Vec<_>>(), budget)?;
                }
                string(canonical::sha256(&canonical_key(&value, budget)?))
            }
            "nonoverlap" => {
                let value = eval(&a[1], budget)?;
                let array = as_array(&value)?;
                let mut intervals = Vec::with_capacity(array.len());
                for item in array {
                    let lower = get(item, text(&a[2])?, budget)?;
                    let upper = get(item, text(&a[3])?, budget)?;
                    let lower = exact::decimal(as_str(&lower)?)?;
                    let upper = exact::decimal(as_str(&upper)?)?;
                    if lower >= upper { return Ok(boolean(false)); }
                    intervals.push((lower, upper));
                }
                let log = if intervals.is_empty() { 0 } else { (usize::BITS - intervals.len().leading_zeros()) as usize };
                budget.spend(intervals.len().saturating_mul(log + 1))?;
                intervals.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                Ok(boolean(intervals.windows(2).all(|pair| pair[0].1 <= pair[1].0)))
            }
            _ => Err(unavailable("unsupported opcode")),
        }
    }
}
