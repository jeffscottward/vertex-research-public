//! Offline native reader for externally pinned Vertex contract bundles.
//!
//! No bundled authority, permissive fallback, filesystem discovery, networking,
//! transport or order authorization is provided. Load the raw bundle with an
//! independently obtained SHA-256 pin; only then validate canonical wire bytes.

mod canonical;
mod exact;
mod ir;
mod replay;
mod schema;

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const SCHEMA_VERSION: &str = "1.0.0";
pub const BUNDLE_FORMAT: &str = "vertex-native-contract-bundle-v1";
pub const HASH_PROFILE: &str = "gamma-json-utf8-safe-integer-v1";
pub const SEMANTIC_PROFILE: &str = "vertex-invariants-v1";
const SOURCES: [&str; 10] = [
    "packages/api/src/contracts/vertex.ts",
    "packages/api/src/contracts/vertex-control.ts",
    "packages/api/src/contracts/vertex-native-facts.ts",
    "packages/api/src/contracts/vertex-worker.ts",
    "packages/api/src/contracts/vertex-worker-experiment.ts",
    "packages/api/src/contracts/vertex-policy.ts",
    "packages/api/src/contracts/vertex-model-use.ts",
    "packages/api/src/contracts/vertex-worker-epoch.ts",
    "packages/shared/src/vertex/index.ts",
    "scripts/vertex-native-contracts/invariants-v1.json",
];
const HEADERS: [&str; 10] = [
    "bundleFormat", "schemaVersion", "hashProfile", "semanticProfile", "sources",
    "schemas", "programs", "contractRules", "programDigest", "sourceDigest",
];

type Result<T, E = ContractError> = std::result::Result<T, E>;

/// Rejection is explicit. Unknown/unsupported authority is never interpreted as
/// an empty schema or a semantic success. Messages do not include payload data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractError {
    PinMismatch,
    Unavailable(String),
    Json(String),
    NonCanonical,
    SchemaVersion,
    UnknownContract,
    Structural,
    Semantic(String),
    Timestamp,
    Limit(&'static str),
}
impl fmt::Display for ContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::PinMismatch => f.write_str("bundle SHA-256 does not match external pin"),
            Self::Unavailable(reason) => write!(f, "contract authority unavailable: {reason}"),
            Self::Json(reason) => write!(f, "invalid JSON: {reason}"),
            Self::NonCanonical => f.write_str("JSON is not canonical safe-integer UTF-8"),
            Self::SchemaVersion => f.write_str("unsupported schema version"),
            Self::UnknownContract => f.write_str("contract is not registered in pinned authority"),
            Self::Structural => f.write_str("contract structural validation rejected payload"),
            Self::Semantic(reason) => write!(f, "contract semantic validation rejected payload: {reason}"),
            Self::Timestamp => f.write_str("invalid exact Gregorian timestamp"),
            Self::Limit(resource) => write!(f, "contract resource limit exceeded: {resource}"),
        }
    }
}
impl std::error::Error for ContractError {}

/// Only `ContractAuthority::validate` constructs an artifact. Fields are private;
/// borrowed accessors cannot mutate the bytes, hash or JSON tree independently.
#[derive(Debug)]
pub struct ValidatedArtifact {
    canonical: Vec<u8>,
    sha256: String,
    value: Value,
}
impl ValidatedArtifact {
    pub fn canonical_bytes(&self) -> &[u8] { &self.canonical }
    pub fn sha256(&self) -> &str { &self.sha256 }
    pub fn value(&self) -> &Value { &self.value }
}

/// Bounded offline/admission authority, not a tick/callback hot-path codec.
///
/// Global ceilings are bundle 8 MiB, payload 64 MiB, one million JSON nodes,
/// depth 64, string 2 MiB and sixteen million schema/semantic work steps;
/// expression integers have a separate 512-bit physical ceiling. These limits
/// are fail-closed safety ceilings, NOT latency/memory proofs or a guarantee
/// that every combination of public schema maxima fits the work budget.
/// Network/API readers must retain stricter per-contract ingress bounds.
/// Load authority off the hot path and admit large snapshots outside callbacks.
pub struct ContractAuthority {
    schemas: BTreeMap<String, schema::Schema>,
    programs: ir::Programs,
    contract_rules: BTreeMap<String, String>,
}
impl ContractAuthority {
    /// The caller's pin is the trust root. Embedded digests only check internal
    /// consistency; they never replace that pin. No source paths are opened.
    pub fn from_bundle(bundle: &[u8], expected_sha256: &str) -> Result<Self> {
        if bundle.len() > canonical::BUNDLE_BYTES { return Err(ContractError::Limit("bundle bytes")); }
        if !canonical::is_digest(expected_sha256) || canonical::sha256(bundle) != expected_sha256 {
            return Err(ContractError::PinMismatch);
        }
        let value = canonical::parse(bundle, canonical::BUNDLE_BYTES)?;
        let root = value.as_object().ok_or_else(|| unavailable("bundle object required"))?;
        if root.keys().map(String::as_str).collect::<BTreeSet<_>>() != HEADERS.into_iter().collect() {
            return Err(unavailable("bundle header fields must match exact format"));
        }
        for (field, expected) in [("bundleFormat", BUNDLE_FORMAT), ("schemaVersion", SCHEMA_VERSION), ("hashProfile", HASH_PROFILE), ("semanticProfile", SEMANTIC_PROFILE)] {
            if root.get(field).and_then(Value::as_str) != Some(expected) { return Err(unavailable("unsupported bundle profile")); }
        }
        let sources = root["sources"].as_object().ok_or_else(|| unavailable("sources object required"))?;
        if sources.keys().map(String::as_str).collect::<BTreeSet<_>>() != SOURCES.into_iter().collect() {
            return Err(unavailable("exact authoritative source set required"));
        }
        if sources.values().any(|v| !v.as_str().is_some_and(canonical::is_digest)) { return Err(unavailable("source digests must be lowercase SHA-256")); }
        for (payload, digest) in [("sources", "sourceDigest"), ("programs", "programDigest")] {
            let expected = root[digest].as_str().filter(|s| canonical::is_digest(s)).ok_or_else(|| unavailable("invalid embedded digest"))?;
            if canonical::sha256(&canonical::encode(&root[payload], canonical::BUNDLE_BYTES)?) != expected {
                return Err(unavailable("embedded source or program digest mismatch"));
            }
        }
        let definitions = root["schemas"].as_object().ok_or_else(|| unavailable("schemas object required"))?;
        let rules = root["contractRules"].as_object().ok_or_else(|| unavailable("contractRules object required"))?;
        if definitions.is_empty() || definitions.keys().collect::<BTreeSet<_>>() != rules.keys().collect() {
            return Err(unavailable("every schema requires exactly one contract rule mapping"));
        }
        let expressions = root["programs"].as_object().ok_or_else(|| unavailable("programs object required"))?;
        let mut budget = canonical::Budget::new();
        let programs = ir::Programs::compile(expressions.iter().map(|(k, v)| (k.clone(), v.clone())).collect(), &mut budget)?;
        let mut contract_rules = BTreeMap::new();
        let mut schemas = BTreeMap::new();
        for (name, definition) in definitions {
            if name.is_empty() { return Err(unavailable("empty contract name")); }
            let rule = rules[name].as_str().ok_or_else(|| unavailable("contract rule must name a program"))?;
            if !programs.contains(rule) { return Err(unavailable("missing contract semantic program")); }
            contract_rules.insert(name.clone(), rule.into());
            schemas.insert(name.clone(), schema::Schema::compile(definition.clone(), &mut budget)?);
        }
        Ok(Self { schemas, programs, contract_rules })
    }

    pub fn validate(&self, contract_name: &str, canonical_json: &[u8], schema_version: &str) -> Result<ValidatedArtifact> {
        if schema_version != SCHEMA_VERSION { return Err(ContractError::SchemaVersion); }
        if contract_name == "NativeOutboxReplay" && canonical_json.len() > replay::WIRE_BYTES {
            return Err(ContractError::Limit("native outbox replay wire bytes"));
        }
        let schema = self.schemas.get(contract_name).ok_or(ContractError::UnknownContract)?;
        let rule = self.contract_rules.get(contract_name).ok_or_else(|| unavailable("missing contract rule"))?;
        let value = canonical::parse(canonical_json, canonical::PAYLOAD_BYTES)?;
        let mut budget = canonical::Budget::new();
        if !schema.validate(&value, &mut budget)? { return Err(ContractError::Structural); }
        if !self.programs.validate(rule, &value, &mut budget)? { return Err(ContractError::Semantic("invariant returned false".into())); }
        if contract_name == "NativeOutboxReplay" { self.validate_replay(&value, schema_version, &mut budget)?; }
        Ok(ValidatedArtifact { canonical: canonical_json.to_vec(), sha256: canonical::sha256(canonical_json), value })
    }

    /// Source-backed two-input proof boundary. This binds canonical proof bytes
    /// to a validated projection and runs the pinned private metadata binding
    /// program; two independent calls to `validate` do not establish this fact.
    /// Publisher authentication, grants and atomic store transactions remain
    /// separate caller responsibilities. A successful proof grants no execution.
    pub fn validate_native_journal_proof(
        &self,
        projection_json: &[u8],
        proof_bytes: &[u8],
        schema_version: &str,
    ) -> Result<ValidatedArtifact> {
        // Enforce the source's tighter proof ingress ceiling before allocating
        // either input tree or copying any proof bytes.
        if proof_bytes.is_empty() || proof_bytes.len() > 1_048_576 {
            return Err(ContractError::Limit("native journal proof bytes"));
        }
        if !self.programs.contains("NativeJournalProofBinding") {
            return Err(unavailable("paired native journal proof binding unavailable"));
        }
        let projection = self.validate("NativeFactProjection", projection_json, schema_version)?;
        let expected = projection.value().get("proof").and_then(|v| v.get("sha256"))
            .and_then(Value::as_str).filter(|s| canonical::is_digest(s))
            .ok_or_else(|| ContractError::Semantic("native projection proof SHA-256 missing".into()))?;
        if canonical::sha256(proof_bytes) != expected {
            return Err(ContractError::Semantic("native proof raw SHA-256 mismatch".into()));
        }
        let proof = self.validate("NativeJournalProof", proof_bytes, schema_version)?;
        // Move the validated trees into the transient binding scope rather
        // than clone a potentially large projection. The returned proof keeps
        // its original canonical bytes and digest without re-encoding.
        let ValidatedArtifact { canonical, sha256, value } = proof;
        let mut scope = serde_json::Map::new();
        scope.insert("projection".into(), projection.value);
        scope.insert("proof".into(), value);
        let mut binding = Value::Object(scope);
        let mut budget = canonical::Budget::new();
        if !self.programs.validate("NativeJournalProofBinding", &binding, &mut budget)? {
            return Err(ContractError::Semantic("native proof observation binding mismatch".into()));
        }
        let value = binding.as_object_mut().and_then(|scope| scope.remove("proof"))
            .ok_or_else(|| unavailable("native proof binding scope unavailable"))?;
        Ok(ValidatedArtifact { canonical, sha256, value })
    }

    pub fn encode(&self, value: &Value) -> Result<Vec<u8>> { canonical::encode(value, canonical::PAYLOAD_BYTES) }
    pub fn digest(&self, value: &Value) -> Result<String> { Ok(canonical::sha256(&self.encode(value)?)) }
    pub fn epoch_ns(&self, value: &str) -> Result<i128> { exact::epoch_ns(value) }
}

fn unavailable(message: &str) -> ContractError { ContractError::Unavailable(message.into()) }
