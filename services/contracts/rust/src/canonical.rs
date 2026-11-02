use crate::{ContractError, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const BUNDLE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PAYLOAD_BYTES: usize = 64 * 1024 * 1024;
pub(crate) const STRING_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_DEPTH: usize = 64;
pub(crate) const MAX_NODES: usize = 1_000_000;
pub(crate) const MAX_STEPS: usize = 16_000_000;
pub(crate) const SAFE: i64 = 9_007_199_254_740_991;

pub(crate) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Lexical resource gate runs BEFORE serde allocates a tree or recurses. It is
/// deliberately not a JSON parser: serde verifies grammar; re-encoding verifies
/// every spelling, duplicate key, key order, escape and insignificant byte.
fn preflight(bytes: &[u8], limit: usize) -> Result<()> {
    if bytes.len() > limit { return Err(ContractError::Limit("JSON bytes")); }
    let mut depth = 0usize;
    let mut nodes = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    let mut token = false;
    let mut string_size = 0usize;
    for &b in bytes {
        if quoted {
            string_size += 1;
            // A single decoded byte can have a six-byte JSON escape spelling.
            if string_size > STRING_BYTES * 6 + 1 { return Err(ContractError::Limit("JSON string")); }
            if escaped { escaped = false; }
            else if b == b'\\' { escaped = true; }
            else if b == b'"' { quoted = false; }
            continue;
        }
        match b {
            b'"' => { quoted = true; escaped = false; token = false; string_size = 0; nodes += 1; }
            b'[' | b'{' => { depth += 1; nodes += 1; token = false; }
            b']' | b'}' => {
                depth = depth.checked_sub(1).ok_or_else(|| ContractError::Json("unbalanced JSON".into()))?;
                token = false;
            }
            b',' | b':' | b' ' | b'\r' | b'\n' | b'\t' => token = false,
            _ if !token => { nodes += 1; token = true; }
            _ => {}
        }
        if depth > MAX_DEPTH { return Err(ContractError::Limit("JSON depth")); }
        if nodes > MAX_NODES { return Err(ContractError::Limit("JSON nodes")); }
    }
    if quoted || depth != 0 { return Err(ContractError::Json("unfinished JSON".into())); }
    Ok(())
}

pub(crate) fn parse(bytes: &[u8], limit: usize) -> Result<Value> {
    preflight(bytes, limit)?;
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ContractError::Json("invalid JSON".into()))?;
    if encode(&value, limit)? != bytes { return Err(ContractError::NonCanonical); }
    Ok(value)
}

pub(crate) fn encode(value: &Value, limit: usize) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut nodes = 0;
    write_value(value, 0, &mut nodes, &mut output, limit)?;
    Ok(output)
}

fn append(out: &mut Vec<u8>, bytes: &[u8], limit: usize) -> Result<()> {
    if out.len().saturating_add(bytes.len()) > limit { return Err(ContractError::Limit("canonical bytes")); }
    out.extend_from_slice(bytes);
    Ok(())
}

fn string(value: &str, out: &mut Vec<u8>, limit: usize) -> Result<()> {
    if value.len() > STRING_BYTES { return Err(ContractError::Limit("JSON string")); }
    // Rust strings are Unicode scalar sequences: lone surrogate code points
    // cannot be represented. serde_json does not ASCII-escape scalar Unicode.
    let encoded = serde_json::to_string(value).map_err(|_| ContractError::Json("string encoding".into()))?;
    append(out, encoded.as_bytes(), limit)
}

fn count(nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    if *nodes > MAX_NODES { return Err(ContractError::Limit("JSON nodes")); }
    Ok(())
}

fn write_value(value: &Value, depth: usize, nodes: &mut usize, out: &mut Vec<u8>, limit: usize) -> Result<()> {
    count(nodes)?;
    match value {
        Value::Null => append(out, b"null", limit),
        Value::Bool(b) => append(out, if *b { b"true" } else { b"false" }, limit),
        Value::Number(n) => {
            // as_i64 rejects every floating representation, including 1.0,
            // exponent syntax and negative zero. Boundary never rounds f64.
            let integer = n.as_i64().filter(|n| (-SAFE..=SAFE).contains(n))
                .ok_or(ContractError::NonCanonical)?;
            append(out, integer.to_string().as_bytes(), limit)
        }
        Value::String(s) => string(s, out, limit),
        Value::Array(a) => {
            if depth >= MAX_DEPTH { return Err(ContractError::Limit("JSON depth")); }
            if a.len() > MAX_NODES.saturating_sub(*nodes) { return Err(ContractError::Limit("JSON nodes")); }
            append(out, b"[", limit)?;
            for (i, item) in a.iter().enumerate() {
                if i != 0 { append(out, b",", limit)?; }
                write_value(item, depth + 1, nodes, out, limit)?;
            }
            append(out, b"]", limit)
        }
        Value::Object(o) => {
            if depth >= MAX_DEPTH { return Err(ContractError::Limit("JSON depth")); }
            if o.len().saturating_mul(2) > MAX_NODES.saturating_sub(*nodes) { return Err(ContractError::Limit("JSON nodes")); }
            append(out, b"{", limit)?;
            let mut keys: Vec<_> = o.keys().collect();
            // UTF-8 lexicographic order equals Unicode scalar/codepoint order,
            // unlike JavaScript's default UTF-16 ordering for astral keys.
            keys.sort_unstable();
            for (i, key) in keys.iter().enumerate() {
                count(nodes)?;
                if i != 0 { append(out, b",", limit)?; }
                string(key, out, limit)?;
                append(out, b":", limit)?;
                write_value(&o[*key], depth + 1, nodes, out, limit)?;
            }
            append(out, b"}", limit)
        }
    }
}

pub(crate) struct Budget { remaining: usize }
impl Budget {
    pub(crate) fn new() -> Self { Self { remaining: MAX_STEPS } }
    pub(crate) fn spend(&mut self, steps: usize) -> Result<()> {
        self.remaining = self.remaining.checked_sub(steps).ok_or(ContractError::Limit("evaluation steps"))?;
        Ok(())
    }
}
