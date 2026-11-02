// Source-authored regressions. No tests or generators were executed in the
// build-only authoring wave. These synthetic bundles are not domain authority.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use vertex_contracts::{ContractAuthority, ContractError};

fn hash(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn canonical(value: &Value) -> Vec<u8> {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Array(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() { if i != 0 { out.push(','); } write(v, out); }
                out.push(']');
            }
            Value::Object(o) => {
                out.push('{');
                let mut keys: Vec<_> = o.keys().collect();
                keys.sort();
                for (i, k) in keys.into_iter().enumerate() {
                    if i != 0 { out.push(','); }
                    out.push_str(&serde_json::to_string(k).unwrap()); out.push(':'); write(&o[k], out);
                }
                out.push('}');
            }
            v => out.push_str(&serde_json::to_string(v).unwrap()),
        }
    }
    let mut out = String::new(); write(value, &mut out); out.into_bytes()
}
fn bundle(schema: Value, expression: Value) -> Value {
    let sources = json!({
        "packages/api/src/contracts/vertex.ts": "a".repeat(64),
        "packages/api/src/contracts/vertex-control.ts": "b".repeat(64),
        "packages/api/src/contracts/vertex-native-facts.ts": "e".repeat(64),
        "packages/api/src/contracts/vertex-worker.ts": "f".repeat(64),
        "packages/api/src/contracts/vertex-policy.ts": "1".repeat(64),
        "packages/api/src/contracts/vertex-model-use.ts": "2".repeat(64),
        "packages/api/src/contracts/vertex-worker-epoch.ts": "3".repeat(64),
        "packages/shared/src/vertex/index.ts": "c".repeat(64),
        "scripts/vertex-native-contracts/invariants-v1.json": "d".repeat(64)
    });
    let programs = json!({ "FixtureRule": expression });
    json!({
        "bundleFormat": "vertex-native-contract-bundle-v1", "schemaVersion": "1.0.0",
        "hashProfile": "gamma-json-utf8-safe-integer-v1", "semanticProfile": "vertex-invariants-v1",
        "sourceDigest": hash(&canonical(&sources)), "programDigest": hash(&canonical(&programs)),
        "sources": sources, "schemas": {"Fixture": schema}, "programs": programs,
        "contractRules": {"Fixture": "FixtureRule"}
    })
}
fn reseal(bundle: &mut Value) {
    bundle["sourceDigest"] = json!(hash(&canonical(&bundle["sources"])));
    bundle["programDigest"] = json!(hash(&canonical(&bundle["programs"])));
}
fn load(value: &Value) -> Result<ContractAuthority, ContractError> {
    let bytes = canonical(value); ContractAuthority::from_bundle(&bytes, &hash(&bytes))
}
fn authority(schema: Value, expression: Value) -> ContractAuthority { load(&bundle(schema, expression)).unwrap() }
fn accepted(schema: Value, expression: Value, payload: Value) -> bool {
    authority(schema, expression).validate("Fixture", &canonical(&payload), "1.0.0").is_ok()
}

#[test]
fn frozen_api_and_read_only_artifact() {
    let authority = authority(json!({"type":"object","properties":{"n":{"type":"integer"}},"required":["n"],"additionalProperties":false}), json!(true));
    let value = json!({"n": 7});
    let bytes = authority.encode(&value).unwrap();
    let artifact = authority.validate("Fixture", &bytes, "1.0.0").unwrap();
    assert_eq!(artifact.canonical_bytes(), b"{\"n\":7}");
    assert_eq!(artifact.sha256(), authority.digest(&value).unwrap());
    assert_eq!(artifact.value(), &value);
    assert!(matches!(authority.validate("Missing", &bytes, "1.0.0"), Err(ContractError::UnknownContract)));
    assert!(matches!(authority.validate("Fixture", &bytes, "2.0.0"), Err(ContractError::SchemaVersion)));
}

#[test]
fn raw_pin_is_not_replaced_by_internal_digests() {
    let value = bundle(json!(true), json!(true));
    let bytes = canonical(&value);
    assert!(matches!(ContractAuthority::from_bundle(&bytes, &"0".repeat(64)), Err(ContractError::PinMismatch)));
    assert!(matches!(ContractAuthority::from_bundle(&bytes, &hash(&bytes).to_uppercase()), Err(ContractError::PinMismatch)));
    let mut changed = value.clone(); changed["hashProfile"] = json!("other");
    assert!(matches!(load(&changed), Err(ContractError::Unavailable(_))));
    for field in ["bundleFormat", "schemaVersion", "semanticProfile"] {
        let mut changed = value.clone(); changed[field] = json!("unknown"); assert!(load(&changed).is_err());
    }
    let mut changed = value.clone(); changed["programDigest"] = json!("0".repeat(64)); assert!(load(&changed).is_err());
    let mut changed = value.clone(); changed["sourceDigest"] = json!("0".repeat(64)); assert!(load(&changed).is_err());
    let mut changed = value.clone(); changed["selfHash"] = json!(hash(&bytes)); assert!(load(&changed).is_err());
    let mut changed = value.clone(); changed["sources"].as_object_mut().unwrap().remove("packages/api/src/contracts/vertex.ts"); reseal(&mut changed); assert!(load(&changed).is_err());
    let mut changed = value; changed["sources"]["packages/api/src/contracts/vertex.ts"] = json!("A".repeat(64)); reseal(&mut changed); assert!(load(&changed).is_err());
}

#[test]
fn complete_rules_and_eager_fail_closed_audit() {
    let value = bundle(json!(true), json!(true));
    let mut changed = value.clone(); changed["contractRules"] = json!({}); assert!(load(&changed).is_err());
    let mut changed = value.clone(); changed["contractRules"]["Unknown"] = json!("FixtureRule"); assert!(load(&changed).is_err());
    let mut changed = value.clone(); changed["contractRules"]["Fixture"] = json!("Missing"); assert!(load(&changed).is_err());
    for schema in [json!({"properties":{"unused":{"futureKeyword":true}}}), json!({"anyOf":[true,{"format":"email"}]}), json!({"$ref":"https://example.invalid/schema"}), json!({"$defs":{"self":{"$ref":"#/$defs/self"}},"$ref":"#/$defs/self"})] {
        assert!(matches!(load(&bundle(schema, json!(true))), Err(ContractError::Unavailable(_))));
    }
    for pattern in ["^.$", "(?i)abc", "[a&&b]", r"\Aabc", r"\p{Letter}+"] {
        assert!(matches!(load(&bundle(json!({"type":"string","pattern":pattern}),json!(true))),Err(ContractError::Unavailable(_))));
    }
    for program in [json!(["if",true,true,["futureOpcode"]]), json!(["call","Missing",null]), json!(["not",true,false]), json!({"not":"an expression"}), json!(["hashOmit",["get",""],["lit",["x","x"]]])] {
        assert!(matches!(load(&bundle(json!(true), program)), Err(ContractError::Unavailable(_))));
    }
    let mut recursive = value; recursive["programs"]["FixtureRule"] = json!(["call","FixtureRule",["get",""]]); reseal(&mut recursive);
    assert!(matches!(load(&recursive), Err(ContractError::Unavailable(_))));
}

#[test]
fn boundary_rejects_alternate_spellings_duplicates_and_unsafe_numbers() {
    let authority = authority(json!(true), json!(true));
    for raw in ["{\"x\":1,\"x\":1}", "{\"z\":0,\"a\":1}", " 0", "0\n", "1.0", "1e0", "-0", "-0.0", "9007199254740992", "-9007199254740992", "\"\\u0061\"", "\"\\ud800\"", "\"\\ud83d\\ude00\""] {
        assert!(authority.validate("Fixture", raw.as_bytes(), "1.0.0").is_err(), "{raw}");
    }
    for raw in ["null", "true", "9007199254740991", "-9007199254740991", "\"😀\"", "{\"a\":1,\"z\":0}"] {
        assert!(authority.validate("Fixture", raw.as_bytes(), "1.0.0").is_ok(), "{raw}");
    }
    assert!(authority.encode(&json!(1.0)).is_err());
    assert!(authority.encode(&json!(-0.0)).is_err());
    assert!(authority.encode(&json!(9_007_199_254_740_992u64)).is_err());
    let value = json!({"𐀀":1,"\u{e000}":2});
    assert_eq!(authority.encode(&value).unwrap(), "{\"\u{e000}\":2,\"𐀀\":1}".as_bytes());
}

#[test]
fn canonical_bundle_is_required_too() {
    let value = bundle(json!(true), json!(true));
    let bytes = serde_json::to_vec_pretty(&value).unwrap();
    assert!(matches!(ContractAuthority::from_bundle(&bytes, &hash(&bytes)), Err(ContractError::NonCanonical)));
}

#[test]
fn gregorian_exact_epoch_vectors() {
    let authority = authority(json!(true), json!(true));
    for (text, expected) in [
        ("1970-01-01T00:00:00Z", 0i128),
        ("1969-12-31T23:59:59.999999999Z", -1),
        ("1970-01-01T01:00:00+01:00", 0),
        ("1970-01-01T00:00:00+23:59", -86_340_000_000_000),
        ("1970-01-01T00:00:00-23:59", 86_340_000_000_000),
        ("0000-01-01T00:00:00Z", -62_167_219_200_000_000_000),
        ("2000-02-29T00:00:00.000000001Z", 951_782_400_000_000_001),
    ] { assert_eq!(authority.epoch_ns(text).unwrap(), expected, "{text}"); }
    for text in ["1900-02-29T00:00:00Z", "2001-02-29T00:00:00Z", "2024-04-31T00:00:00Z", "2024-01-01T24:00:00Z", "2024-01-01T00:00:60Z", "2024-01-01T00:00:00+24:00", "2024-01-01T00:00:00+01:60", "2024-01-01T00:00:00.1234567890Z", "2024-01-01T00:00Z", "2024-01-01T00:00:00Z\n", "2024-01-01t00:00:00z", "2024-01-01T00:00:00", "2024-01-01T00:00:00.Z"] { assert!(authority.epoch_ns(text).is_err(), "{text}"); }
    assert!(authority.epoch_ns("0000-02-29T00:00:00Z").is_ok());
}

#[test]
fn source_patterns_ascii_digits_utf16_lengths_and_nested_calendar() {
    let timestamp = r"^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$";
    let schema = json!({"type":"object","properties":{"nested":{"type":"array","items":{"type":"string","pattern":timestamp}}}});
    assert!(!accepted(schema.clone(), json!(true), json!({"nested":["2024-02-30T00:00:00Z"]})));
    assert!(accepted(schema, json!(true), json!({"nested":["2024-02-29T00:00:00Z"]})));
    assert!(!accepted(json!({"type":"string","pattern":r"^(0|[1-9]\d{0,29})$"}), json!(true), json!("1١")));
    assert!(!accepted(json!({"type":"string","pattern":r"^[A-Z]{3}$"}), json!(true), json!("USD\n")));
    assert!(accepted(json!({"type":"string","maxLength":2}), json!(true), json!("😀")));
    assert!(!accepted(json!({"type":"string","maxLength":1}), json!(true), json!("😀")));
    assert!(accepted(json!({"type":"string","pattern":r"^[^\u0000-\u001f\u007f\ud800-\udfff]*$"}), json!(true), json!("😀 text")));
    assert!(!accepted(json!({"type":"string","pattern":r"^[^\u0000-\u001f\u007f\ud800-\udfff]*$"}), json!(true), json!("bad\ttext")));
    for pattern in [r"^[1-9][0-9]{0,29}$",r"^[1-9]\d{0,29}$"] {
        assert!(accepted(json!({"type":"string","pattern":pattern}),json!(true),json!("123")));
        assert!(!accepted(json!({"type":"string","pattern":pattern}),json!(true),json!("0")));
        assert!(!accepted(json!({"type":"string","pattern":pattern}),json!(true),json!("1١")));
    }
    assert!(accepted(json!({"type":"string","pattern":r"^[A-Z][A-Z0-9_]{0,127}$"}),json!(true),json!("PROVIDER_TOKEN")));
    assert!(!accepted(json!({"type":"string","pattern":r"^[A-Z][A-Z0-9_]{0,127}$"}),json!(true),json!("lower")));
    let base64 = json!({"type":"string","pattern":r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$","maxLength":1398104});
    assert!(accepted(base64.clone(),json!(true),json!("AAAA".repeat(349_526))));
    assert!(!accepted(base64.clone(),json!(true),json!("A===")));
    assert!(!accepted(base64,json!(true),json!("AAAA".repeat(349_527))));
}

#[test]
fn structural_subset_and_local_refs_are_conjunctive() {
    let schema = json!({"$schema":"https://json-schema.org/draft/2020-12/schema", "$defs":{"positive":{"type":"integer","minimum":1}}, "type":"object", "properties":{"n":{"$ref":"#/$defs/positive","maximum":3},"a":{"type":"array","items":{"enum":["a","b"]},"minItems":1,"maxItems":2,"uniqueItems":true}},"required":["n","a"],"additionalProperties":false});
    assert!(accepted(schema.clone(), json!(true), json!({"n":3,"a":["a","b"]})));
    for payload in [json!({"n":4,"a":["a"]}),json!({"n":0,"a":["a"]}),json!({"n":1,"a":["a","a"]}),json!({"n":1,"a":["c"]}),json!({"n":1}),json!({"n":1,"a":["b"],"extra":true})] { assert!(!accepted(schema.clone(), json!(true), payload)); }
    assert!(accepted(json!({"oneOf":[{"type":"string"},{"type":"integer"}],"not":{"const":0}}),json!(true),json!(1)));
    assert!(!accepted(json!({"oneOf":[true,true]}),json!(true),json!(1)));
    assert!(!accepted(json!({"allOf":[{"minimum":1},{"maximum":2}]}),json!(true),json!(3)));
    assert!(accepted(json!({"anyOf":[{"type":"null"},{"const":"yes"}]}),json!(true),json!(null)));
}

#[test]
fn full_numeric_and_string_ir() {
    let program = json!(["and",
        ["eq",["add",2,3],5], ["eq",["sub",2,3],-1], ["eq",["mod",-7,3],-1],
        ["eq",["mul",["integer","9007199254740991"],2],["add",9007199254740991,9007199254740991]],
        ["gt",["decimal","0.000000000000000001"],0], ["eq",["decimal","-0.000000000000000001"],-1],
        ["lt",["epoch","1969-12-31T23:59:59.999999999Z"],0], ["le",["integer","0"],0], ["ge",2,2],
        ["ne",true,1], ["not",["eq",null,false]], ["eq",["concat","a","b","c"],"abc"],
        ["eq",["len","😀"],2], ["eq",["slice","a😀z",1,3],"😀"],
        ["eq",["slice","abcd",-2,99],"cd"], ["timestamp","0000-02-29T00:00:00Z"],
        ["if",true,true,["eq",["get","missing"],0]], ["or",true,["eq",["get","missing"],0]]
    ]);
    assert!(accepted(json!(true), program, json!({})));
    for decimal in ["-0","01","1.0","1e3","0.0000000000000000001","1000000000000000000000000000000"] {
        assert!(!accepted(json!(true), json!(["eq",["decimal",decimal],0]),json!({})));
    }
    assert!(!accepted(json!(true),json!(["eq",["slice","😀",0,1],""]),json!(null)));
    assert!(!accepted(json!(true),json!(["lt",1,"1"]),json!(null)));
    assert!(!accepted(json!(true),json!(["eq",["integer","00"],0]),json!(null)));
    assert!(!accepted(json!(true),json!(["eq",["mod",1,0],0]),json!(null)));
}

#[test]
fn nested_calls_root_parent_and_short_circuit() {
    let payload = json!({"id":99,"groups":[{"id":7,"items":[{"id":8},{"id":7}]}]});
    let program = json!(["every",["get","groups"],["and",["eq",["root","id"],99],["some",["get","items"],["eq",["get","id"],["parent","id"]]]]]);
    assert!(accepted(json!(true),program,payload.clone()));
    let mut value = bundle(json!(true),json!(["every",["get","groups"],["call","Child",["get",""]]]));
    value["programs"]["Child"] = json!(["eq",["root","id"],7]); reseal(&mut value);
    assert!(load(&value).unwrap().validate("Fixture",&canonical(&payload),"1.0.0").is_ok());
    value["programs"]["Child"] = json!(["eq",["parent","id"],99]); reseal(&mut value);
    assert!(load(&value).unwrap().validate("Fixture",&canonical(&payload),"1.0.0").is_err());
    assert!(!accepted(json!(true),json!(["eq",["get","missing"],null]),json!({"present":null})));
    assert!(accepted(json!(true),json!(["eq",["get","present"],null]),json!({"present":null})));
    assert!(accepted(json!(true),json!(["every",["lit",[]],false]),json!(null)));
    assert!(!accepted(json!(true),json!(["some",["lit",[]],true]),json!(null)));
}

#[test]
fn collection_hash_and_interval_ir() {
    let payload = json!({"a":1,"b":2,"hash":"ignored"});
    let expected = hash(b"{\"a\":1,\"b\":2}");
    let expression = json!(["and",
        ["eq",["hashOmit",["get",""],["lit",["hash"]]],expected],
        ["eq",["keys",["lit",{"z":2,"a":1}]],["lit",["a","z"]]],
        ["eq",["values",["lit",{"z":2,"a":1}]],["lit",[1,2]]],
        ["contains",["lit",[1,true,null]],true], ["unique",["lit",[1,true,null]]],
        ["uniqueBy",["lit",[{"id":"x"},{"id":"y"}]],"id"],
        ["nonoverlap",["lit",[{"lo":"2","hi":"3"},{"lo":"1","hi":"2"}]],"lo","hi"]
    ]);
    assert!(accepted(json!(true),expression,payload));
    assert!(!accepted(json!(true),json!(["unique",["lit",[{"a":1,"b":2},{"b":2,"a":1}]]]),json!(null)));
    assert!(!accepted(json!(true),json!(["uniqueBy",["lit",[{"id":"x"},{"id":"x"}]],"id"]),json!(null)));
    assert!(!accepted(json!(true),json!(["nonoverlap",["lit",[{"lo":"1","hi":"3"},{"lo":"2","hi":"4"}]],"lo","hi"]),json!(null)));
    assert!(!accepted(json!(true),json!(["eq",["hashOmit",["get",""],["lit",["missing"]]],""]),json!({})));
}

#[test]
fn nested_hash_omissions_are_finite_strict_and_immutable() {
    let payload = json!({"sourceEventHash":"old","continuity":{"highWaterEventHash":"old","highWaterSequence":"0"},"positions":[]});
    let filtered = json!({"continuity":{"highWaterSequence":"0"},"positions":[]});
    let expression = json!(["eq",["hashOmitPaths",["get",""],["lit",["sourceEventHash","continuity.highWaterEventHash"]]],hash(&canonical(&filtered))]);
    let authority = authority(json!(true),expression);
    let artifact = authority.validate("Fixture",&canonical(&payload),"1.0.0").unwrap();
    assert_eq!(artifact.value(),&payload);
    for paths in [json!(["continuity","continuity.highWaterEventHash"]),json!(["sourceEventHash","sourceEventHash"]),json!([""]),json!(["a..b"]),json!([1]),json!(["a".repeat(2049)]),json!(["a.".repeat(64)+"a"])] {
        assert!(matches!(load(&bundle(json!(true),json!(["hashOmitPaths",["get",""],["lit",paths]]))),Err(ContractError::Unavailable(_))));
    }
    for payload in [json!({}),json!({"sourceEventHash":"old","continuity":null}),json!({"sourceEventHash":"old","continuity":[]}),json!({"sourceEventHash":"old","continuity":{}})] {
        assert!(!accepted(json!(true),json!(["eq",["hashOmitPaths",["get",""],["lit",["sourceEventHash","continuity.highWaterEventHash"]]],""]),payload));
    }
}

#[test]
fn uri_profile_uses_whatwg_accessors_without_rewriting_source() {
    let schema = json!({"type":"string","format":"uri","maxLength":2048,"pattern":r"^[^\ud800-\udfff]*$"});
    let authority = authority(schema, json!(["publicHttps",["get",""]]));
    // Expected public-source behavior, authored but not yet cross-run against
    // the pinned JS and Rust parsers. Inputs retain their original hash bytes.
    for uri in [
        "https://example.com/paper/123", "HTTPS://example.com", "https://example.com.:443/a",
        "https://127.0.0.1/a", "https://127.1", "https://2130706433", "https://0x7f000001",
        "https://0177.0.0.1", "https://127.0.0.1.", "https://[::1]:65535/a",
        "https://[2001:db8::1]/a", "https://example.com:", "https://xn--bcher-kva.example",
        "https://bücher.example", "https://%65xample.com", "https://@example.com",
        "https://:@example.com", "https://example.com?", "https://example.com#",
        "https://example.com?#", "https://example.com/a@b", " https://example.com ",
        "https://exa\tmple.com", "https://example.com/\n", "https://example.com\\path",
        "https:example.com", "https:/example.com", "https:\\example.com", "https:///example.com",
    ] {
        let payload = json!(uri);
        let bytes = canonical(&payload);
        let artifact = authority.validate("Fixture",&bytes,"1.0.0").unwrap_or_else(|error| panic!("URI fixture rejected: {uri:?}: {error}"));
        assert_eq!(artifact.value(),&payload);
        assert_eq!(artifact.canonical_bytes(),bytes);
        assert_eq!(artifact.sha256(),hash(&bytes));
    }
    for uri in [
        "http://example.com", "https://u:p@example.com", "https://u:@example.com",
        "https://:p@example.com", "https://example.com?x", "https://example.com#x",
        "https://example.com:65536", "https://example.com:+443", "https://[fe80::1%25eth0]",
        "https://exa mple.com", "https://%", "https://[::1", "https://",
    ] {
        assert!(authority.validate("Fixture",&canonical(&json!(uri)),"1.0.0").is_err(),"{uri}");
    }
    let limit = format!("https://example.com/{}","😀".repeat(1014));
    assert_eq!(limit.encode_utf16().count(),2048);
    assert!(authority.validate("Fixture",&canonical(&json!(limit.clone())),"1.0.0").is_ok());
    assert!(authority.validate("Fixture",&canonical(&json!(limit+"a")),"1.0.0").is_err());
}

#[test]
fn resource_limits_precede_deserialization_and_bound_programs() {
    let authority = authority(json!(true), json!(true));
    let deep = format!("{}0{}", "[".repeat(65), "]".repeat(65));
    assert!(matches!(authority.validate("Fixture",deep.as_bytes(),"1.0.0"),Err(ContractError::Limit(_))));
    assert!(matches!(authority.encode(&json!("x".repeat(2*1024*1024+1))),Err(ContractError::Limit(_))));
    let many = format!("[{}]", vec!["0";1_000_001].join(","));
    assert!(matches!(authority.validate("Fixture",many.as_bytes(),"1.0.0"),Err(ContractError::Limit(_))));
    assert!(matches!(ContractAuthority::from_bundle(&vec![b' ';8*1024*1024+1],&"0".repeat(64)),Err(ContractError::Limit(_))));
    let n = json!(["decimal","999999999999999999999999999999"]);
    let square = json!(["mul",n.clone(),n]);
    let fourth = json!(["mul",square.clone(),square]);
    assert!(!accepted(json!(true),json!(["gt",fourth,0]),json!(null)));
    let values = json!(vec![0;2000]);
    let expression = json!(["every",["lit",values.clone()],["every",["lit",values],["eq",["get",""],0]]]);
    assert!(matches!(authority_for_budget(expression).validate("Fixture",b"null","1.0.0"),Err(ContractError::Limit(_))));
}
fn authority_for_budget(expression: Value) -> ContractAuthority { authority(json!(true),expression) }

fn paired_authority(binding: Value) -> ContractAuthority {
    // Deliberately synthetic schemas isolate paired-helper mechanics; shared
    // generated conformance fixtures exercise authoritative domain shapes.
    let mut source = bundle(json!(true),json!(true));
    source["schemas"] = json!({"NativeFactProjection":true,"NativeJournalProof":true});
    source["contractRules"] = json!({"NativeFactProjection":"Projection","NativeJournalProof":"Proof"});
    source["programs"] = json!({
        "Projection":["eq",["get","eventHash"],["hashOmit",["get",""],["lit",["eventHash"]]]],
        "Proof":true,"NativeJournalProofBinding":binding
    });
    reseal(&mut source);
    load(&source).unwrap()
}
fn projection_for(proof_bytes: &[u8], account: &str, fact: Value) -> Value {
    let mut projection = json!({"accountAlias":account,"fact":fact,"proof":{"sha256":hash(proof_bytes)}});
    projection["eventHash"] = json!(hash(&canonical(&projection)));
    projection
}

#[test]
fn paired_proof_runs_projection_hash_raw_digest_and_binding() {
    let authority = paired_authority(json!(["and",
        ["eq",["get","projection.accountAlias"],["get","proof.accountAlias"]],
        ["eq",["get","projection.fact"],["get","proof.payload"]]
    ]));
    let fact = json!({"kind":"test-only","value":1});
    let proof = json!({"accountAlias":"account","payload":fact.clone()});
    let proof_bytes = canonical(&proof);
    let projection = projection_for(&proof_bytes,"account",fact.clone());
    let artifact = authority.validate_native_journal_proof(&canonical(&projection),&proof_bytes,"1.0.0").unwrap();
    assert_eq!(artifact.value(),&proof);
    assert_eq!(artifact.canonical_bytes(),proof_bytes);
    assert_eq!(artifact.sha256(),hash(&proof_bytes));
    let mut wrong_hash = projection.clone();
    wrong_hash["eventHash"] = json!("0".repeat(64));
    assert!(authority.validate_native_journal_proof(&canonical(&wrong_hash),&proof_bytes,"1.0.0").is_err());
    let other_proof = canonical(&json!({"accountAlias":"other","payload":fact.clone()}));
    assert!(authority.validate_native_journal_proof(&canonical(&projection),&other_proof,"1.0.0").is_err());
    let rebound = projection_for(&other_proof,"account",fact);
    assert!(authority.validate("NativeFactProjection",&canonical(&rebound),"1.0.0").is_ok());
    assert!(authority.validate("NativeJournalProof",&other_proof,"1.0.0").is_ok());
    assert!(authority.validate_native_journal_proof(&canonical(&rebound),&other_proof,"1.0.0").is_err());
}

#[test]
fn paired_proof_requires_original_canonical_bytes_and_private_program() {
    let authority = paired_authority(json!(true));
    for proof_bytes in [b"{\"a\":1,\"a\":1}".as_slice(),b"{ \"a\":1}",b"{\"a\":1}\n",b"{\"a\":-0}",b"\"\\ud800\"",b"\xef\xbb\xbf{}"] {
        let projection = projection_for(proof_bytes,"account",json!(null));
        assert!(authority.validate_native_journal_proof(&canonical(&projection),proof_bytes,"1.0.0").is_err());
    }
    assert!(matches!(authority.validate_native_journal_proof(b"invalid",b"","1.0.0"),Err(ContractError::Limit(_))));
    assert!(matches!(authority.validate_native_journal_proof(b"invalid",&vec![b' ';1_048_577],"1.0.0"),Err(ContractError::Limit(_))));
    let unavailable = load(&bundle(json!(true),json!(true))).unwrap();
    assert!(matches!(unavailable.validate_native_journal_proof(b"{}",b"{}","1.0.0"),Err(ContractError::Unavailable(_))));
}

#[test]
fn finite_index_sum_at_and_base64_length_ir() {
    assert!(accepted(json!(true),json!(["and",
        ["every",["lit",[5,6]],["eq",["at",["lit",[5,6]],["index"]],["get",""]]],
        ["eq",["sum",["lit",[1,2,3]],["get",""]],6],
        ["eq",["sum",["lit",[1,2,3]],["index"]],3],
        ["eq",["sum",["lit",[]],["get",""]],0],
        ["eq",["base64Length","Zg=="],1]
    ]),json!(null)));
    let payload = json!({"offset":1,"rows":[{"bias":10,"values":[1,2]},{"bias":100,"values":[3]}]});
    assert!(accepted(json!(true),json!(["eq",["sum",["get","rows"],["sum",["get","values"],["add",["get",""],["parent","bias"]]]],126]),payload.clone()));
    assert!(accepted(json!(true),json!(["eq",["sum",["get","rows"],["sum",["get","values"],["add",["get",""],["root","offset"]]]],9]),payload));
    for expression in [json!(["eq",["index"],0]),json!(["eq",["at",["lit",[1]],-1],1]),json!(["eq",["at",["lit",[1]],1],1]),json!(["eq",["at",["lit",[1]],true],1]),json!(["eq",["sum",["lit",[true]],["get",""]],1])] {
        assert!(!accepted(json!(true),expression,json!(null)));
    }
    let mut source = bundle(json!(true),json!(["every",["lit",[1]],["call","Child",["get",""]]]));
    source["programs"]["Child"] = json!(["eq",["index"],0]); reseal(&mut source);
    assert!(load(&source).unwrap().validate("Fixture",b"null","1.0.0").is_err());
    for spelling in ["","Zg","Zh==","Zg==\n","_w==","é==="] {
        assert!(!accepted(json!(true),json!(["gt",["base64Length",spelling],0]),json!(null)));
    }
    let maximum = "AAAA".repeat(349_525)+"AA==";
    assert!(accepted(json!(true),json!(["eq",["base64Length",["get",""]],1_048_576]),json!(maximum)));
    assert!(!accepted(json!(true),json!(["gt",["base64Length",["get",""]],0]),json!("AAAA".repeat(349_526))));
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
fn replay_source(binding: Value) -> Value {
    let mut source = bundle(json!(true),json!(true));
    source["schemas"] = json!({"NativeOutboxReplay":true,"PortfolioGenesis":true,"PortfolioSnapshot":true,"ExecutionProjection":true,"NativeFactProjection":true,"Wrapper":true});
    source["contractRules"] = json!({"NativeOutboxReplay":"Replay","PortfolioGenesis":"Child","PortfolioSnapshot":"Child","ExecutionProjection":"Child","NativeFactProjection":"Child","Wrapper":"Replay"});
    source["programs"] = json!({"Replay":true,"Child":true,"NativeReplayRowBinding":binding});
    reseal(&mut source);
    source
}
fn replay_one(kind: &str, payload: Value) -> Value {
    let bytes = canonical(&payload);
    json!({"retainedEpochTransitionBase64":null,"grant":{"retainedEpochTransitionSha256":null,"accountAlias":"account","startingEventHash":null,"approvalBase64":"AQ==",
        "rows":[{"kind":kind,"projectionRawSha256":hash(&bytes),"eventHash":"a".repeat(64),"proofSha256":null}]},
        "rows":[{"kind":kind,"projectionBase64":base64_encode(&bytes),"proofBase64":null}]})
}

#[test]
fn standalone_replay_adapter_preserves_bytes_and_nested_rule_scope() {
    let authority = load(&replay_source(json!(["eq",["get","value.accountAlias"],["get","grant.accountAlias"]]))).unwrap();
    let replay = replay_one("portfolio-genesis",json!({"accountAlias":"account"}));
    let bytes = canonical(&replay);
    let artifact = authority.validate("NativeOutboxReplay",&bytes,"1.0.0").unwrap();
    assert_eq!(artifact.canonical_bytes(),bytes);
    assert_eq!(artifact.value(),&replay);
    let mut raw_mismatch = replay.clone();
    raw_mismatch["grant"]["rows"][0]["projectionRawSha256"] = json!("0".repeat(64));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&raw_mismatch),"1.0.0").is_err());
    let binding_mismatch = replay_one("order",json!({"accountAlias":"other"}));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&binding_mismatch),"1.0.0").is_err());
    let mut noncanonical = replay.clone();
    let raw = b"{ \"accountAlias\":\"account\"}";
    noncanonical["rows"][0]["projectionBase64"] = json!(base64_encode(raw));
    noncanonical["grant"]["rows"][0]["projectionRawSha256"] = json!(hash(raw));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&noncanonical),"1.0.0").is_err());
    // Synthetic wrapper rule uses metadata semantics only: it must not trigger
    // standalone replay byte parsing by inspecting a nested DTO's shape.
    assert!(authority.validate("Wrapper",&canonical(&noncanonical),"1.0.0").is_ok());
    assert!(matches!(authority.validate("NativeOutboxReplay",&vec![b' ';12_582_913],"1.0.0"),Err(ContractError::Limit(_))));
}

#[test]
fn replay_aggregate_ceiling_and_native_fact_paired_boundary() {
    let mut source = replay_source(json!(true));
    source["schemas"]["NativeJournalProof"] = json!(true);
    source["contractRules"]["NativeJournalProof"] = json!("Child");
    source["programs"]["NativeJournalProofBinding"] = json!(true);
    reseal(&mut source);
    let authority = load(&source).unwrap();
    let proof_bytes = b"{\"evidence\":\"test-only\"}";
    let projection = json!({"accountAlias":"account","proof":{"sha256":hash(proof_bytes)}});
    let mut replay = replay_one("native-fact",projection.clone());
    replay["rows"][0]["proofBase64"] = json!(base64_encode(proof_bytes));
    replay["grant"]["rows"][0]["proofSha256"] = json!(hash(proof_bytes));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&replay),"1.0.0").is_ok());
    let mut wrong_projection = projection;
    wrong_projection["proof"]["sha256"] = json!("0".repeat(64));
    let wrong_bytes = canonical(&wrong_projection);
    replay["rows"][0]["projectionBase64"] = json!(base64_encode(&wrong_bytes));
    replay["grant"]["rows"][0]["projectionRawSha256"] = json!(hash(&wrong_bytes));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&replay),"1.0.0").is_err());
    let mut oversized = replay_one("order",json!({}));
    let maximum = "AAAA".repeat(349_525)+"AA==";
    let row = json!({"kind":"order","projectionBase64":maximum,"proofBase64":null});
    let identity = oversized["grant"]["rows"][0].clone();
    oversized["rows"] = json!(vec![row;8]);
    oversized["grant"]["rows"] = json!(vec![identity;8]);
    // Eight full 1MiB blobs plus even one approval byte exceed the source
    // aggregate ceiling, before attempting to parse the non-JSON row bytes.
    assert!(matches!(authority.validate("NativeOutboxReplay",&canonical(&oversized),"1.0.0"),Err(ContractError::Limit(_))));
}

#[test]
fn retained_transition_binds_raw_canonical_snapshot_scope_and_full_child() {
    let mut source = replay_source(json!(true));
    source["schemas"]["PortfolioEpochTransition"] = json!(true);
    source["contractRules"]["PortfolioEpochTransition"] = json!("Transition");
    source["programs"]["Transition"] = json!(true);
    source["programs"]["NativeReplayRetainedTransitionBinding"] = json!(["and",
        ["eq",["get","transition.snapshot.ownerEpoch"],["get","grant.priorOwnerEpoch"]],
        ["eq",["get","transition.snapshot.accountAlias"],["get","grant.accountAlias"]],
        ["eq",["get","transition.snapshot.streamId"],["get","grant.streamId"]]
    ]);
    reseal(&mut source);
    let authority = load(&source).unwrap();
    let snapshot = json!({"ownerEpoch":"2","accountAlias":"account","streamId":"stream"});
    let transition = json!({"snapshot":snapshot.clone()});
    let transition_bytes = canonical(&transition);
    let mut replay = replay_one("portfolio-genesis",snapshot);
    replay["grant"]["priorOwnerEpoch"] = json!("2");
    replay["grant"]["streamId"] = json!("stream");
    replay["retainedEpochTransitionBase64"] = json!(base64_encode(&transition_bytes));
    replay["grant"]["retainedEpochTransitionSha256"] = json!(hash(&transition_bytes));
    let bytes = canonical(&replay);
    let artifact = authority.validate("NativeOutboxReplay",&bytes,"1.0.0").unwrap();
    assert_eq!(artifact.value(),&replay);
    assert_eq!(artifact.canonical_bytes(),bytes);
    for field in ["priorOwnerEpoch","accountAlias","streamId"] {
        let mut bad = replay.clone(); bad["grant"][field] = json!("different");
        assert!(authority.validate("NativeOutboxReplay",&canonical(&bad),"1.0.0").is_err());
    }
    let mut bad = replay.clone(); bad["grant"]["retainedEpochTransitionSha256"] = json!("0".repeat(64));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&bad),"1.0.0").is_err());
    let mut bad = replay.clone(); bad["rows"][0]["kind"] = json!("order"); bad["grant"]["rows"][0]["kind"] = json!("order");
    assert!(authority.validate("NativeOutboxReplay",&canonical(&bad),"1.0.0").is_err());
    let mut different_transition = transition.clone(); different_transition["snapshot"]["extra"] = json!(true);
    let different_bytes = canonical(&different_transition);
    let mut bad = replay.clone(); bad["retainedEpochTransitionBase64"] = json!(base64_encode(&different_bytes));
    bad["grant"]["retainedEpochTransitionSha256"] = json!(hash(&different_bytes));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&bad),"1.0.0").is_err());
    let pretty = serde_json::to_vec_pretty(&transition).unwrap();
    let mut bad = replay.clone(); bad["retainedEpochTransitionBase64"] = json!(base64_encode(&pretty));
    bad["grant"]["retainedEpochTransitionSha256"] = json!(hash(&pretty));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&bad),"1.0.0").is_err());
    source["programs"]["Transition"] = json!(false); reseal(&mut source);
    assert!(load(&source).unwrap().validate("NativeOutboxReplay",&bytes,"1.0.0").is_err());
}

#[test]
fn retained_transition_nulls_are_mandatory_and_count_toward_aggregate() {
    let authority = load(&replay_source(json!(true))).unwrap();
    let replay = replay_one("order",json!({}));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&replay),"1.0.0").is_ok());
    let mut missing = replay.clone(); missing.as_object_mut().unwrap().remove("retainedEpochTransitionBase64");
    assert!(authority.validate("NativeOutboxReplay",&canonical(&missing),"1.0.0").is_err());
    let mut missing = replay.clone(); missing["grant"].as_object_mut().unwrap().remove("retainedEpochTransitionSha256");
    assert!(authority.validate("NativeOutboxReplay",&canonical(&missing),"1.0.0").is_err());
    let mut mismatch = replay.clone(); mismatch["retainedEpochTransitionBase64"] = json!("AQ==");
    assert!(authority.validate("NativeOutboxReplay",&canonical(&mismatch),"1.0.0").is_err());
    let mut mismatch = replay.clone(); mismatch["grant"]["retainedEpochTransitionSha256"] = json!("0".repeat(64));
    assert!(authority.validate("NativeOutboxReplay",&canonical(&mismatch),"1.0.0").is_err());
    let maximum = "AAAA".repeat(349_525)+"AA==";
    let row = json!({"kind":"order","projectionBase64":maximum.clone(),"proofBase64":null});
    let identity = replay["grant"]["rows"][0].clone();
    let mut oversized = replay;
    oversized["rows"] = json!(vec![row;7]); oversized["grant"]["rows"] = json!(vec![identity;7]);
    oversized["retainedEpochTransitionBase64"] = json!(maximum);
    oversized["grant"]["retainedEpochTransitionSha256"] = json!("0".repeat(64));
    // Seven projections + one retained sidecar + approval = 8MiB + one byte.
    assert!(matches!(authority.validate("NativeOutboxReplay",&canonical(&oversized),"1.0.0"),Err(ContractError::Limit(_))));
}
