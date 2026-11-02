//! Deferred offline runner. Explicit positional arguments only:
//! conformance BUNDLE_FILE BUNDLE_SHA256 FIXTURES_FILE FIXTURES_SHA256
//! Both pins must come from the caller, not from files beside either input.
//! This source has not been compiled or executed during the authoring wave.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use vertex_contracts::{ContractAuthority, ContractError};

type Result<T, E = String> = std::result::Result<T, E>;
const BUNDLE_BYTES: usize = 8 * 1024 * 1024;
const FIXTURE_BYTES: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 1_000_000;
const STRING_BYTES: usize = 2 * 1024 * 1024;

fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn pinned_file(path: &Path, pin: &str, limit: usize) -> Result<Vec<u8>> {
    if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("external pin must be lowercase SHA-256".into());
    }
    let file = File::open(path).map_err(|_| "cannot open explicit input".to_string())?;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes).map_err(|_| "cannot read explicit input".to_string())?;
    if bytes.len() > limit { return Err("input exceeds fixed profile byte limit".into()); }
    if hash(&bytes) != pin { return Err("explicit input SHA-256 pin mismatch".into()); }
    Ok(bytes)
}

fn fixture_preflight(bytes: &[u8]) -> Result<()> {
    let (mut depth, mut nodes, mut length) = (0usize, 0usize, 0usize);
    let (mut quoted, mut escaped, mut token) = (false, false, false);
    for &b in bytes {
        if quoted {
            length += 1;
            if length > STRING_BYTES * 6 + 1 { return Err("fixture string limit".into()); }
            if escaped { escaped = false; }
            else if b == b'\\' { escaped = true; }
            else if b == b'"' { quoted = false; }
            continue;
        }
        match b {
            b'"' => { quoted = true; escaped = false; token = false; length = 0; nodes += 1; }
            b'[' | b'{' => { depth += 1; nodes += 1; token = false; }
            b']' | b'}' => { depth = depth.checked_sub(1).ok_or("invalid fixture JSON")?; token = false; }
            b',' | b':' | b' ' | b'\r' | b'\n' | b'\t' => token = false,
            _ if !token => { nodes += 1; token = true; }
            _ => {}
        }
        if depth > MAX_DEPTH || nodes > MAX_NODES { return Err("fixture depth/node limit".into()); }
    }
    if depth != 0 || quoted { return Err("invalid fixture JSON".into()); }
    Ok(())
}

fn fixture_strings(value: &Value) -> Result<()> {
    match value {
        Value::String(s) if s.len() > STRING_BYTES => return Err("fixture decoded string limit".into()),
        Value::Array(values) => { for value in values { fixture_strings(value)?; } }
        Value::Object(values) => {
            for (key, value) in values {
                if key.len() > STRING_BYTES { return Err("fixture decoded key limit".into()); }
                fixture_strings(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    let object = value.as_object().ok_or("fixture object required")?;
    if object.keys().map(String::as_str).collect::<BTreeSet<_>>() != fields.iter().copied().collect() {
        return Err("fixture fields do not match exact format".into());
    }
    Ok(object)
}
fn text<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str> {
    object.get(field).and_then(Value::as_str).ok_or_else(|| format!("fixture string field required: {field}"))
}
fn array<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a [Value]> {
    object.get(field).and_then(Value::as_array).map(Vec::as_slice).ok_or_else(|| format!("fixture array field required: {field}"))
}
fn hex(text: &str) -> Result<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid raw byte fixture hex".into()); }
    text.as_bytes().chunks_exact(2).map(|b| {
        let h = (b[0] as char).to_digit(16).ok_or("invalid hex")?;
        let l = (b[1] as char).to_digit(16).ok_or("invalid hex")?;
        Ok((h * 16 + l) as u8)
    }).collect()
}
fn expected_rejection(error: &ContractError) -> bool {
    matches!(error, ContractError::Json(_) | ContractError::NonCanonical | ContractError::Structural
        | ContractError::Semantic(_) | ContractError::Timestamp | ContractError::Limit(_))
}

fn run() -> Result<Value> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 { return Err("usage: conformance BUNDLE_FILE BUNDLE_SHA256 FIXTURES_FILE FIXTURES_SHA256".into()); }
    let bundle_pin = args[1].to_str().ok_or("bundle pin must be UTF-8")?;
    let fixture_pin = args[3].to_str().ok_or("fixture pin must be UTF-8")?;
    let bundle = pinned_file(Path::new(&args[0]), bundle_pin, BUNDLE_BYTES)?;
    let authority = ContractAuthority::from_bundle(&bundle, bundle_pin).map_err(|e| e.to_string())?;
    let fixture_bytes = pinned_file(Path::new(&args[2]), fixture_pin, FIXTURE_BYTES)?;
    fixture_preflight(&fixture_bytes)?;
    let fixtures: Value = serde_json::from_slice(&fixture_bytes).map_err(|_| "invalid fixture JSON")?;
    fixture_strings(&fixtures)?;
    let root = object(&fixtures, &["fixtureFormat", "schemaVersion", "cases", "rawByteReject", "codec", "timestamps"])?;
    if text(root, "fixtureFormat")? != "vertex-native-contract-fixtures-v1" || text(root, "schemaVersion")? != "1.0.0" {
        return Err("unsupported fixture format/schema version".into());
    }
    let cases = array(root, "cases")?;
    let mut names = BTreeSet::new();
    let mut raw_contract = None;
    for (index, case) in cases.iter().enumerate() {
        let case = object(case, &["name", "contract", "payload", "valid"])?;
        if !names.insert(text(case, "name")?) { return Err("duplicate fixture case name".into()); }
        let contract = text(case, "contract")?;
        let expected = case["valid"].as_bool().ok_or("case valid must be boolean")?;
        let outcome = authority.encode(&case["payload"]).and_then(|bytes| authority.validate(contract, &bytes, "1.0.0"));
        match &outcome {
            Ok(_) if expected => { if raw_contract.is_none() { raw_contract = Some(contract); } }
            Err(error) if !expected && expected_rejection(error) => {}
            _ => return Err(format!("contract conformance mismatch at case {index}")),
        }
    }
    let raw_contract = raw_contract.ok_or("at least one valid registered fixture case required")?;
    let raw_cases = array(root, "rawByteReject")?;
    for (index, case) in raw_cases.iter().enumerate() {
        let case = object(case, &["name", "hex"])?;
        text(case, "name")?;
        let bytes = hex(text(case, "hex")?)?;
        match authority.validate(raw_contract, &bytes, "1.0.0") {
            Err(ContractError::Json(_) | ContractError::NonCanonical | ContractError::Limit(_)) => {}
            _ => return Err(format!("canonical raw byte rejection mismatch at case {index}")),
        }
    }
    let codecs = array(root, "codec")?;
    for (index, case) in codecs.iter().enumerate() {
        let case = object(case, &["name", "value", "canonicalUtf8", "sha256"])?;
        text(case, "name")?;
        let bytes = authority.encode(&case["value"]).map_err(|_| format!("codec encoding rejected case {index}"))?;
        if bytes != text(case, "canonicalUtf8")?.as_bytes()
            || authority.digest(&case["value"]).map_err(|e| e.to_string())? != text(case, "sha256")? {
            return Err(format!("codec conformance mismatch at case {index}"));
        }
    }
    let timestamps = array(root, "timestamps")?;
    for (index, case) in timestamps.iter().enumerate() {
        let case = object(case, &["timestamp", "epochNanoseconds"])?;
        let outcome = authority.epoch_ns(text(case, "timestamp")?);
        match &case["epochNanoseconds"] {
            Value::Null if outcome.is_err() => {}
            Value::String(expected) => {
                let integer = expected.parse::<i128>().map_err(|_| "invalid timestamp expectation")?;
                if integer.to_string() != *expected || outcome != Ok(integer) { return Err(format!("timestamp conformance mismatch at case {index}")); }
            }
            _ => return Err(format!("timestamp rejection mismatch at case {index}")),
        }
    }
    Ok(json!({"conformanceFormat":"vertex-native-contract-conformance-v1","runtime":"rust",
        "passed":true,"cases":cases.len(),"rawByteReject":raw_cases.len(),"codec":codecs.len(),"timestamps":timestamps.len()}))
}

fn main() {
    match run() {
        Ok(summary) => println!("{summary}"),
        Err(error) => { eprintln!("{error}"); std::process::exit(1); }
    }
}
