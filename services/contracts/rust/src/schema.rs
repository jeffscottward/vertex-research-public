use crate::canonical::{self, Budget, MAX_DEPTH};
use crate::exact;
use crate::{ContractError, Result};
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct Schema {
    root: Value,
    patterns: BTreeMap<String, Regex>,
}

fn unavailable(message: &str) -> ContractError { ContractError::Unavailable(message.into()) }
fn object(value: &Value) -> Result<&Map<String, Value>> {
    value.as_object().ok_or_else(|| unavailable("schema must be object or boolean"))
}
fn size(value: &Value) -> Result<usize> {
    value.as_u64().and_then(|n| usize::try_from(n).ok()).ok_or_else(|| unavailable("schema size must be nonnegative integer"))
}
fn number(value: &Value) -> Result<i64> {
    value.as_i64().ok_or_else(|| unavailable("schema numeric constraint must be safe integer"))
}
fn types(value: &Value) -> Result<Vec<&str>> {
    let names: Vec<&str> = if let Some(s) = value.as_str() { vec![s] }
    else if let Some(values) = value.as_array() {
        values.iter().map(|v| v.as_str().ok_or_else(|| unavailable("invalid schema type"))).collect::<Result<_>>()?
    } else { return Err(unavailable("invalid schema type")); };
    if names.is_empty() || names.iter().collect::<BTreeSet<_>>().len() != names.len()
        || names.iter().any(|n| !matches!(*n, "null" | "boolean" | "integer" | "number" | "string" | "array" | "object")) {
        return Err(unavailable("unsupported schema type"));
    }
    Ok(names)
}

fn reference<'a>(root: &'a Value, value: &Value) -> Result<&'a Value> {
    let text = value.as_str().ok_or_else(|| unavailable("invalid schema reference"))?;
    // No external retrieval, base URI, anchors or percent-decoding ambiguity.
    if !text.starts_with("#/") || text.contains('%') { return Err(unavailable("only local JSON pointer references supported")); }
    let pointer = &text[1..];
    for segment in pointer.split('/') {
        let mut chars = segment.chars();
        while let Some(c) = chars.next() {
            if c == '~' && !matches!(chars.next(), Some('0' | '1')) { return Err(unavailable("invalid reference escape")); }
        }
    }
    root.pointer(pointer).ok_or_else(|| unavailable("unresolved schema reference"))
}

impl Schema {
    pub(crate) fn compile(root: Value, budget: &mut Budget) -> Result<Self> {
        let mut patterns = BTreeMap::new();
        Self::audit(&root, &root, &mut patterns, budget, 0)?;
        Ok(Self { root, patterns })
    }

    fn audit(schema: &Value, root: &Value, patterns: &mut BTreeMap<String, Regex>, budget: &mut Budget, depth: usize) -> Result<()> {
        budget.spend(1)?;
        if depth > MAX_DEPTH { return Err(unavailable("recursive or overly deep schema")); }
        if schema.is_boolean() { return Ok(()); }
        for (key, value) in object(schema)? {
            budget.spend(1)?;
            match key.as_str() {
                "$schema" => {
                    if value.as_str() != Some("https://json-schema.org/draft/2020-12/schema") {
                        return Err(unavailable("unsupported JSON Schema dialect"));
                    }
                }
                "$ref" => Self::audit(reference(root, value)?, root, patterns, budget, depth + 1)?,
                "$defs" | "properties" => {
                    for child in value.as_object().ok_or_else(|| unavailable("schema map expected"))?.values() {
                        Self::audit(child, root, patterns, budget, depth + 1)?;
                    }
                }
                "additionalProperties" | "items" | "not" => Self::audit(value, root, patterns, budget, depth + 1)?,
                "anyOf" | "allOf" | "oneOf" | "prefixItems" => {
                    let branches = value.as_array().ok_or_else(|| unavailable("schema alternatives must be array"))?;
                    if branches.is_empty() { return Err(unavailable("empty schema alternatives")); }
                    for child in branches { Self::audit(child, root, patterns, budget, depth + 1)?; }
                }
                "type" => { types(value)?; }
                "required" => {
                    let mut seen = BTreeSet::new();
                    for item in value.as_array().ok_or_else(|| unavailable("required must be array"))? {
                        if !seen.insert(item.as_str().ok_or_else(|| unavailable("required must contain strings"))?) {
                            return Err(unavailable("duplicate required property"));
                        }
                    }
                }
                "minItems" | "maxItems" | "minLength" | "maxLength" | "minProperties" | "maxProperties" => { size(value)?; }
                "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" => { number(value)?; }
                "multipleOf" => { if number(value)? <= 0 { return Err(unavailable("multipleOf must be positive")); } }
                "enum" => {
                    let values = value.as_array().ok_or_else(|| unavailable("enum must be array"))?;
                    if values.is_empty() { return Err(unavailable("empty enum")); }
                    let mut seen = BTreeSet::new();
                    for value in values {
                        if !seen.insert(canonical::encode(value, canonical::BUNDLE_BYTES)?) { return Err(unavailable("duplicate enum member")); }
                    }
                }
                "const" => {}
                "pattern" => {
                    let pattern = value.as_str().ok_or_else(|| unavailable("pattern must be string"))?;
                    if !patterns.contains_key(pattern) { patterns.insert(pattern.into(), exact::portable_regex(pattern)?); }
                }
                "format" => {
                    if !matches!(value.as_str(), Some("uri" | "date-time")) { return Err(unavailable("unsupported schema format")); }
                }
                "title" | "description" => { if !value.is_string() { return Err(unavailable("invalid schema annotation")); } }
                "readOnly" | "writeOnly" | "deprecated" | "uniqueItems" => {
                    if !value.is_boolean() { return Err(unavailable("schema boolean expected")); }
                }
                "default" => {}
                "examples" => { if !value.is_array() { return Err(unavailable("examples must be array")); } }
                _ => return Err(ContractError::Unavailable(format!("unsupported schema keyword: {key}"))),
            }
        }
        Ok(())
    }

    pub(crate) fn validate(&self, value: &Value, budget: &mut Budget) -> Result<bool> {
        self.matches(&self.root, value, budget, 0)
    }

    fn matches(&self, schema: &Value, value: &Value, budget: &mut Budget, depth: usize) -> Result<bool> {
        budget.spend(1)?;
        if depth > MAX_DEPTH { return Err(ContractError::Limit("schema evaluation depth")); }
        if let Some(b) = schema.as_bool() { return Ok(b); }
        let map = object(schema)?;
        if let Some(r) = map.get("$ref") {
            if !self.matches(reference(&self.root, r)?, value, budget, depth + 1)? { return Ok(false); }
        }
        if let Some(t) = map.get("type") {
            let mut matched = false;
            for t in types(t)? {
                matched |= match t {
                    "null" => value.is_null(), "boolean" => value.is_boolean(),
                    "integer" | "number" => value.as_i64().is_some(), "string" => value.is_string(),
                    "array" => value.is_array(), "object" => value.is_object(), _ => false,
                };
            }
            if !matched { return Ok(false); }
        }
        if let Some(c) = map.get("const") { if !equal(c, value, budget)? { return Ok(false); } }
        if let Some(values) = map.get("enum").and_then(Value::as_array) {
            let mut found = false;
            for item in values { if equal(item, value, budget)? { found = true; break; } }
            if !found { return Ok(false); }
        }
        for name in ["allOf", "anyOf", "oneOf"] {
            if let Some(branches) = map.get(name).and_then(Value::as_array) {
                let mut successes = 0;
                for branch in branches {
                    let matched = self.matches(branch, value, budget, depth + 1)?;
                    if name == "allOf" && !matched { return Ok(false); }
                    if matched { successes += 1; }
                    if name == "anyOf" && matched { break; }
                    if name == "oneOf" && successes > 1 { return Ok(false); }
                }
                if (name == "anyOf" && successes == 0) || (name == "oneOf" && successes != 1) { return Ok(false); }
            }
        }
        if let Some(negative) = map.get("not") {
            if self.matches(negative, value, budget, depth + 1)? { return Ok(false); }
        }
        if let Some(n) = value.as_i64() {
            for (key, compare) in [("minimum", 0), ("maximum", 1), ("exclusiveMinimum", 2), ("exclusiveMaximum", 3), ("multipleOf", 4)] {
                if let Some(bound) = map.get(key) {
                    let b = number(bound)?;
                    let ok = match compare { 0 => n >= b, 1 => n <= b, 2 => n > b, 3 => n < b, _ => n % b == 0 };
                    if !ok { return Ok(false); }
                }
            }
        }
        if let Some(s) = value.as_str() {
            budget.spend(s.len().div_ceil(1024))?;
            // Zod string lengths are JavaScript UTF-16 code units, not UTF-8
            // bytes or Unicode scalar counts. No Unicode normalization occurs.
            let length = s.encode_utf16().count();
            if !bounded(map, "minLength", "maxLength", length)? { return Ok(false); }
            if let Some(pattern) = map.get("pattern").and_then(Value::as_str) {
                let regex = self.patterns.get(pattern).ok_or_else(|| unavailable("uncompiled pattern"))?;
                if !regex.is_match(s) { return Ok(false); }
                // Refinements disappear in JSON Schema. This exact source
                // primitive must keep calendar validity at every nested path.
                if pattern == exact::TIMESTAMP_PATTERN && exact::epoch_ns(s).is_err() { return Ok(false); }
            }
            if let Some(format) = map.get("format").and_then(Value::as_str) {
                if (format == "uri" && url::Url::parse(s).is_err()) || (format == "date-time" && exact::epoch_ns(s).is_err()) { return Ok(false); }
            }
        }
        if let Some(array) = value.as_array() {
            if !bounded(map, "minItems", "maxItems", array.len())? { return Ok(false); }
            let prefix = map.get("prefixItems").and_then(Value::as_array);
            let prefix_len = prefix.map_or(0, Vec::len);
            for (i, item) in array.iter().enumerate() {
                let child = prefix.and_then(|p| p.get(i)).or_else(|| if i >= prefix_len { map.get("items") } else { None });
                if let Some(child) = child { if !self.matches(child, item, budget, depth + 1)? { return Ok(false); } }
            }
            if map.get("uniqueItems").and_then(Value::as_bool) == Some(true) {
                let mut seen = BTreeSet::new();
                for item in array {
                    let bytes = canonical::encode(item, canonical::PAYLOAD_BYTES)?;
                    budget.spend(bytes.len())?;
                    if !seen.insert(bytes) { return Ok(false); }
                }
            }
        }
        if let Some(o) = value.as_object() {
            if !bounded(map, "minProperties", "maxProperties", o.len())? { return Ok(false); }
            if let Some(required) = map.get("required").and_then(Value::as_array) {
                for key in required { if !o.contains_key(key.as_str().ok_or_else(|| unavailable("invalid required"))?) { return Ok(false); } }
            }
            let properties = map.get("properties").and_then(Value::as_object);
            for (key, item) in o {
                budget.spend(1)?;
                let child = properties.and_then(|p| p.get(key)).or_else(|| map.get("additionalProperties"));
                if let Some(child) = child { if !self.matches(child, item, budget, depth + 1)? { return Ok(false); } }
            }
        }
        Ok(true)
    }
}

fn bounded(map: &Map<String, Value>, min: &str, max: &str, length: usize) -> Result<bool> {
    if let Some(v) = map.get(min) { if length < size(v)? { return Ok(false); } }
    if let Some(v) = map.get(max) { if length > size(v)? { return Ok(false); } }
    Ok(true)
}

fn equal(a: &Value, b: &Value, budget: &mut Budget) -> Result<bool> {
    // Charge comparisons by canonical input bytes, including nested structures.
    let a = canonical::encode(a, canonical::BUNDLE_BYTES)?;
    let b = canonical::encode(b, canonical::BUNDLE_BYTES)?;
    budget.spend(a.len().saturating_add(b.len()))?;
    Ok(a == b)
}
