//! Source-backed byte adapter for parseNativeOutboxReplay, not a new schema or
//! domain opcode. Nested worker DTO rule calls remain structural/semantic only.
use crate::canonical::{self, Budget};
use crate::exact;
use crate::{ContractAuthority, ContractError, Result};
use serde_json::{Map, Value};

pub(crate) const WIRE_BYTES: usize = 12_582_912;
const DECODED_BYTES: usize = 8_388_608;
fn rejected(reason: &str) -> ContractError { ContractError::Semantic(reason.into()) }
fn field<'a>(object: &'a Value, key: &str) -> Result<&'a Value> {
    object.as_object().and_then(|o| o.get(key)).ok_or_else(|| rejected("missing replay field"))
}
fn text<'a>(object: &'a Value, key: &str) -> Result<&'a str> {
    field(object,key)?.as_str().ok_or_else(|| rejected("replay string field required"))
}
fn array<'a>(object: &'a Value, key: &str) -> Result<&'a [Value]> {
    field(object,key)?.as_array().map(Vec::as_slice).ok_or_else(|| rejected("replay array field required"))
}
fn decoded(text: &str, budget: &mut Budget) -> Result<Vec<u8>> {
    budget.spend(text.len().div_ceil(1024))?;
    exact::base64_bytes(text)
}
fn add_total(total: &mut usize, amount: usize) -> Result<()> {
    *total = total.checked_add(amount).ok_or(ContractError::Limit("native replay decoded bytes"))?;
    if *total > DECODED_BYTES { return Err(ContractError::Limit("native replay decoded bytes")); }
    Ok(())
}
fn raw_hash(bytes: &[u8], expected: &Value) -> Result<()> {
    let expected = expected.as_str().filter(|s| canonical::is_digest(s)).ok_or_else(|| rejected("replay raw SHA-256 required"))?;
    if canonical::sha256(bytes) != expected { return Err(rejected("native replay raw SHA-256 mismatch")); }
    Ok(())
}

impl ContractAuthority {
    pub(crate) fn validate_replay(&self, replay: &Value, version: &str, budget: &mut Budget) -> Result<()> {
        if !self.programs.contains("NativeReplayRowBinding") {
            return Err(ContractError::Unavailable("native replay row binding unavailable".into()));
        }
        let grant = field(replay,"grant")?;
        let rows = array(replay,"rows")?;
        let identities = array(grant,"rows")?;
        if rows.is_empty() || rows.len() > 64 || rows.len() != identities.len() { return Err(rejected("native replay row count mismatch")); }
        let retained = field(replay,"retainedEpochTransitionBase64")?;
        let retained_sha = field(grant,"retainedEpochTransitionSha256")?;
        if retained.is_null() != retained_sha.is_null() { return Err(rejected("retained epoch transition null pairing mismatch")); }
        // Complete the bounded aggregate byte check before child validation.
        // Decode at most one <=1MiB blob at a time; no aggregate decoded copy.
        let mut total = 0;
        add_total(&mut total,decoded(text(grant,"approvalBase64")?,budget)?.len())?;
        if !retained.is_null() {
            add_total(&mut total,decoded(retained.as_str().ok_or_else(|| rejected("retained transition base64 required"))?,budget)?.len())?;
        }
        for row in rows {
            add_total(&mut total,decoded(text(row,"projectionBase64")?,budget)?.len())?;
            let proof = field(row,"proofBase64")?;
            if !proof.is_null() {
                add_total(&mut total,decoded(proof.as_str().ok_or_else(|| rejected("replay proof base64 required"))?,budget)?.len())?;
            }
        }
        if !retained.is_null() {
            if !self.programs.contains("NativeReplayRetainedTransitionBinding") {
                return Err(ContractError::Unavailable("retained epoch transition binding unavailable".into()));
            }
            let bytes = decoded(retained.as_str().ok_or_else(|| rejected("retained transition base64 required"))?,budget)?;
            raw_hash(&bytes,retained_sha)?;
            let transition = self.validate("PortfolioEpochTransition",&bytes,version)?;
            let first = &rows[0];
            if text(first,"kind")? != "portfolio-genesis" { return Err(rejected("retained transition requires first genesis row")); }
            let first_bytes = decoded(text(first,"projectionBase64")?,budget)?;
            if self.encode(field(transition.value(),"snapshot")?)? != first_bytes {
                return Err(rejected("retained transition snapshot canonical bytes mismatch"));
            }
            let mut scope = Map::new();
            scope.insert("grant".into(),grant.clone());
            scope.insert("transition".into(),transition.value().clone());
            if !self.programs.validate("NativeReplayRetainedTransitionBinding",&Value::Object(scope),budget)? {
                return Err(rejected("retained transition scope or owner epoch mismatch"));
            }
            // Historical provenance is not current approval. This check never
            // revives an old signature or bypasses fresh replay authorization.
        }
        let mut prior_hash = field(grant,"startingEventHash")?.clone();
        for (row,identity) in rows.iter().zip(identities) {
            budget.spend(1)?;
            let kind = text(row,"kind")?;
            if kind != text(identity,"kind")? { return Err(rejected("native replay row kind mismatch")); }
            let name = match kind {
                "portfolio-genesis" => "PortfolioGenesis",
                "portfolio-snapshot" => "PortfolioSnapshot",
                "order" => "ExecutionProjection",
                "native-fact" => "NativeFactProjection",
                _ => return Err(rejected("unsupported native replay row kind")),
            };
            let bytes = decoded(text(row,"projectionBase64")?,budget)?;
            raw_hash(&bytes,field(identity,"projectionRawSha256")?)?;
            // Fixed child mapping prevents recursive replay dispatch. validate
            // checks original scalar UTF-8, exact canonical bytes and each
            // selected source helper's own hash/semantic profile.
            let artifact = self.validate(name,&bytes,version)?;
            let mut scope = Map::new();
            scope.insert("grant".into(),grant.clone());
            scope.insert("identity".into(),identity.clone());
            scope.insert("value".into(),artifact.value().clone());
            scope.insert("priorHash".into(),prior_hash.clone());
            if !self.programs.validate("NativeReplayRowBinding",&Value::Object(scope),budget)? {
                return Err(rejected("native replay scope or chain binding mismatch"));
            }
            let proof_base64 = field(row,"proofBase64")?;
            if kind == "native-fact" {
                let proof = decoded(proof_base64.as_str().ok_or_else(|| rejected("native fact replay proof missing"))?,budget)?;
                raw_hash(&proof,field(identity,"proofSha256")?)?;
                self.validate_native_journal_proof(&bytes,&proof,version)?;
            } else if !proof_base64.is_null() || !field(identity,"proofSha256")?.is_null() {
                return Err(rejected("only native fact replay rows carry proofs"));
            }
            // Snapshots describe an existing head; they do not advance it.
            // Event identity hashes and raw serialization hashes stay distinct.
            if kind != "portfolio-snapshot" { prior_hash = field(identity,"eventHash")?.clone(); }
        }
        Ok(())
    }
}
