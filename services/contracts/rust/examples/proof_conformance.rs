//! Source-only paired boundary runner, not executed during authoring.
//! proof_conformance BUNDLE_FILE BUNDLE_SHA256 PROOF_FIXTURES_FILE FIXTURES_SHA256
//! No source/bundle discovery, network access or implicit authority pin.
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
const MAX_NODES: usize = 1_000_000;
const MAX_DEPTH: usize = 64;
const STRING_BYTES: usize = 2 * 1024 * 1024;

fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn pinned_file(path: &Path, pin: &str, limit: usize) -> Result<Vec<u8>> {
    if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("external pin must be lowercase SHA-256".into());
    }
    let file = File::open(path).map_err(|_| "cannot open explicit input")?;
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes).map_err(|_| "cannot read explicit input")?;
    if bytes.len() > limit { return Err("input exceeds fixed byte ceiling".into()); }
    if hash(&bytes) != pin { return Err("explicit input SHA-256 pin mismatch".into()); }
    Ok(bytes)
}
fn preflight(bytes: &[u8]) -> Result<()> {
    let (mut depth, mut nodes, mut length) = (0usize, 0usize, 0usize);
    let (mut quoted, mut escaped, mut token) = (false, false, false);
    for &b in bytes {
        if quoted {
            length += 1;
            // Hex test data can encode one byte beyond the 1 MiB proof ceiling
            // to exercise rejection; this allowance is not a payload increase.
            if length > (STRING_BYTES + 2) * 6 + 1 { return Err("fixture string ceiling".into()); }
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
        if depth > MAX_DEPTH || nodes > MAX_NODES { return Err("fixture depth/node ceiling".into()); }
    }
    if depth != 0 || quoted { return Err("invalid fixture JSON".into()); }
    Ok(())
}
fn object<'a>(value: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    let object = value.as_object().ok_or("fixture object required")?;
    if object.keys().map(String::as_str).collect::<BTreeSet<_>>() != fields.iter().copied().collect() {
        return Err("fixture fields do not match exact format".into());
    }
    Ok(object)
}
fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object.get(key).and_then(Value::as_str).ok_or_else(|| format!("fixture string field required: {key}"))
}
fn decode_hex(text: &str) -> Result<Vec<u8>> {
    // Permit one byte past source maximum so rejection can be fixture-tested.
    if text.len() > (1_048_576 + 1) * 2 || text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid or oversized proof fixture hex".into());
    }
    text.as_bytes().chunks_exact(2).map(|pair| {
        let high = (pair[0] as char).to_digit(16).ok_or("invalid hex")?;
        let low = (pair[1] as char).to_digit(16).ok_or("invalid hex")?;
        Ok((high * 16 + low) as u8)
    }).collect()
}
fn run() -> Result<Value> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 { return Err("usage: proof_conformance BUNDLE_FILE BUNDLE_SHA256 PROOF_FIXTURES_FILE FIXTURES_SHA256".into()); }
    let bundle_pin = args[1].to_str().ok_or("bundle pin must be UTF-8")?;
    let fixture_pin = args[3].to_str().ok_or("fixture pin must be UTF-8")?;
    let bundle = pinned_file(Path::new(&args[0]),bundle_pin,BUNDLE_BYTES)?;
    let authority = ContractAuthority::from_bundle(&bundle,bundle_pin).map_err(|e| e.to_string())?;
    let bytes = pinned_file(Path::new(&args[2]),fixture_pin,FIXTURE_BYTES)?;
    preflight(&bytes)?;
    let document: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid proof fixture JSON")?;
    let root = object(&document,&["proofFixtureFormat","schemaVersion","cases"])?;
    if text(root,"proofFixtureFormat")? != "vertex-native-journal-proof-fixtures-v1" || text(root,"schemaVersion")? != "1.0.0" {
        return Err("unsupported proof fixture format".into());
    }
    let cases = root["cases"].as_array().ok_or("proof fixture cases array required")?;
    if cases.is_empty() { return Err("proof fixture cases cannot be empty".into()); }
    let mut names = BTreeSet::new();
    for (index,case) in cases.iter().enumerate() {
        let case = object(case,&["name","projection","proofHex","valid"])?;
        let name = text(case,"name")?;
        if name.len() > STRING_BYTES || !names.insert(name) { return Err("duplicate or oversized proof case name".into()); }
        let proof = decode_hex(text(case,"proofHex")?)?;
        let expected = case["valid"].as_bool().ok_or("proof case valid must be boolean")?;
        let outcome = authority.encode(&case["projection"])
            .and_then(|projection| authority.validate_native_journal_proof(&projection,&proof,"1.0.0"));
        match outcome {
            Ok(artifact) if expected => {
                if artifact.canonical_bytes() != proof || artifact.sha256() != hash(&proof) {
                    return Err(format!("proof artifact changed source bytes at case {index}"));
                }
            }
            Err(ContractError::Json(_) | ContractError::NonCanonical | ContractError::Structural
                | ContractError::Semantic(_) | ContractError::Timestamp | ContractError::Limit(_)) if !expected => {}
            _ => return Err(format!("paired proof conformance mismatch at case {index}")),
        }
    }
    Ok(json!({"proofConformanceFormat":"vertex-native-journal-proof-conformance-v1","runtime":"rust","passed":true,"cases":cases.len()}))
}
fn main() {
    match run() {
        Ok(summary) => println!("{summary}"),
        Err(error) => { eprintln!("{error}"); std::process::exit(1); }
    }
}
