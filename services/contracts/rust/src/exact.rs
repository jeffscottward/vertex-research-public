use base64::Engine;
use crate::{ContractError, Result};
use num_bigint::BigInt;
use regex::Regex;
use std::sync::LazyLock;

pub(crate) fn base64_bytes(text: &str) -> Result<Vec<u8>> {
    // Bound the encoded spelling BEFORE decoding or allocating output. The
    // worker DTO's regex alone intentionally does not call this primitive.
    if text.is_empty() || !text.is_ascii() || text.len() > 1_398_104 {
        return Err(ContractError::Semantic("invalid bounded base64 spelling".into()));
    }
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine.decode(text).map_err(|_| ContractError::Semantic("invalid RFC4648 base64".into()))?;
    if bytes.is_empty() || bytes.len() > 1_048_576 || engine.encode(&bytes) != text {
        return Err(ContractError::Semantic("noncanonical or oversized base64".into()));
    }
    Ok(bytes)
}

pub(crate) const TIMESTAMP_PATTERN: &str = r"^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(?:\.([0-9]{1,9}))?(Z|([+-])([01][0-9]|2[0-3]):([0-5][0-9]))$";

pub(crate) fn epoch_ns(text: &str) -> Result<i128> {
    // Fixed grammar, no host clock, timezone database, floats or platform dates.
    if !(20..=35).contains(&text.len()) || !text.is_ascii() { return Err(ContractError::Timestamp); }
    let b = text.as_bytes();
    let part = |start: usize, end: usize| -> Result<i128> {
        let raw = b.get(start..end).ok_or(ContractError::Timestamp)?;
        if !raw.iter().all(u8::is_ascii_digit) { return Err(ContractError::Timestamp); }
        Ok(raw.iter().fold(0, |n, d| n * 10 + i128::from(d - b'0')))
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return Err(ContractError::Timestamp);
    }
    let year = part(0, 4)?;
    let month = part(5, 7)?;
    let day = part(8, 10)?;
    let hour = part(11, 13)?;
    let minute = part(14, 16)?;
    let second = part(17, 19)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days: [i128; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&month) || day < 1 || day > month_days[(month - 1) as usize]
        || hour > 23 || minute > 59 || second > 59 { return Err(ContractError::Timestamp); }
    let mut pos = 19;
    let mut nanos = 0;
    if b.get(pos) == Some(&b'.') {
        pos += 1;
        let start = pos;
        while b.get(pos).is_some_and(u8::is_ascii_digit) { pos += 1; }
        let digits = pos - start;
        if !(1..=9).contains(&digits) { return Err(ContractError::Timestamp); }
        nanos = part(start, pos)? * 10i128.pow((9 - digits) as u32);
    }
    let offset = match b.get(pos) {
        Some(b'Z') if pos + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if pos + 6 == b.len() && b[pos + 3] == b':' => {
            let h = part(pos + 1, pos + 3)?;
            let m = part(pos + 4, pos + 6)?;
            if h > 23 || m > 59 { return Err(ContractError::Timestamp); }
            (h * 3600 + m * 60) * if *sign == b'+' { 1 } else { -1 }
        }
        _ => return Err(ContractError::Timestamp),
    };
    let years = |y: i128| y * 365 + (y + 3) / 4 - (y + 99) / 100 + (y + 399) / 400;
    let days = years(year) - years(1970) + month_days[..(month - 1) as usize].iter().sum::<i128>() + day - 1;
    Ok((days * 86400 + hour * 3600 + minute * 60 + second - offset) * 1_000_000_000 + nanos)
}

pub(crate) fn decimal(text: &str) -> Result<BigInt> {
    static DECIMAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A(?:0|-?(?:[1-9][0-9]{0,29}(?:\.[0-9]{0,17}[1-9])?|0\.[0-9]{0,17}[1-9]))\z").expect("constant decimal regex"));
    if !DECIMAL.is_match(text) { return Err(ContractError::Semantic("noncanonical decimal".into())); }
    let negative = text.starts_with('-');
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let digits = format!("{whole}{fraction}{}", "0".repeat(18 - fraction.len()));
    let value = BigInt::parse_bytes(digits.as_bytes(), 10).ok_or_else(|| ContractError::Semantic("decimal".into()))?;
    Ok(if negative { -value } else { value })
}

pub(crate) fn integer(text: &str) -> Result<BigInt> {
    if text.is_empty() || text.len() > 30 || !text.bytes().all(|c| c.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0')) {
        return Err(ContractError::Semantic("noncanonical sequence".into()));
    }
    BigInt::parse_bytes(text.as_bytes(), 10).ok_or_else(|| ContractError::Semantic("integer".into()))
}

/// Match SourceUri's accessor checks using the pinned WHATWG URL parser.
/// Parsing may normalize a temporary URL, but never rewrites the input artifact.
/// JS URL.search/hash are empty for absent OR empty delimiters; URL.password
/// is likewise empty for absent OR empty userinfo. Do not impose a narrower
/// hostname, case, raw whitespace, slash or recovery-spelling policy here.
/// `public` means publishable/no credentials, NOT a network SSRF grant.
/// Parser-version parity still requires the deferred shared conformance lane.
pub(crate) fn public_https(text: &str) -> bool {
    // Source z.string().max(2048) uses UTF-16 code units. JSON already excludes
    // lone surrogates, and this check does not normalize scalar Unicode.
    if text.encode_utf16().count() > 2048 { return false; }
    match url::Url::parse(text) {
        Ok(url) => url.scheme() == "https" && url.username().is_empty()
            && url.password().is_none_or(str::is_empty)
            && url.query().is_none_or(str::is_empty)
            && url.fragment().is_none_or(str::is_empty),
        Err(_) => false,
    }
}


const SUPPORTED_SCHEMA_PATTERNS: [&str; 17] = [
    r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$",
    r"^[0-9a-f]{64}$",
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$",
    r"^(?:0|-?(?:[1-9]\d{0,29}(?:\.\d{0,17}[1-9])?|0\.\d{0,17}[1-9]))$",
    r"^(?:0|[1-9]\d{0,29})(?:\.\d{0,17}[1-9])?$",
    r"^[A-Z]{3}$",
    r"^[^\u0000-\u001f\u007f\ud800-\udfff]*$",
    r"^replay-manifest-[0-9a-f]{24}$",
    r"^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$",
    r"^[^\ud800-\udfff]*$",
    r"^event-[0-9a-f]{64}$",
    r"^(0|[1-9]\d{0,29})$",
    r"^[1-9][0-9]{0,29}$",
    r"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    r"^[1-9]\d{0,29}$",
    r"^[A-Z][A-Z0-9_]{0,127}$",
    TIMESTAMP_PATTERN,
];

pub(crate) fn portable_regex(pattern: &str) -> Result<Regex> {
    // Finite profile support, not pattern inference. New source patterns need
    // a coordinated native profile review even when Rust could compile them.
    if !SUPPORTED_SCHEMA_PATTERNS.contains(&pattern) {
        return Err(ContractError::Unavailable("schema pattern outside frozen source profile".into()));
    }
    // Only these two exact source patterns have UTF-16 surrogate classes.
    // Scalar Unicode is already enforced by the JSON boundary, so exclusion
    // of surrogates is tautological. Do not strip arbitrary surrogate syntax.
    let source = match pattern {
        r"^[^\u0000-\u001f\u007f\ud800-\udfff]*$" => r"^[^\x{0000}-\x{001f}\x{007f}]*$",
        r"^[^\ud800-\udfff]*$" => r"(?s)^.*$",
        other => other,
    };
    let scalar_pattern = source != pattern;
    // JSON Schema does not preserve JS regex flags. Outside the two audited
    // scalar patterns, admit the ASCII-only matching subset used by Vertex.
    // In particular an unflagged JS dot consumes one UTF-16 code unit whereas
    // a Rust dot consumes one scalar; pretending these are equal is unsafe.
    if !scalar_pattern && (!source.is_ascii() || source.contains("[^")
        || source.contains("&&") || source.contains("--") || source.contains("~~")
        || source.split("(?").skip(1).any(|suffix| !suffix.starts_with(':'))) {
        return Err(ContractError::Unavailable("unsupported portable regex dialect".into()));
    }
    let mut translated = String::new();
    let mut chars = source.chars().peekable();
    let mut in_class = false;
    while let Some(ch) = chars.next() {
        match ch {
            '[' => {
                if in_class { return Err(ContractError::Unavailable("nested regex class".into())); }
                in_class = true; translated.push(ch);
            }
            ']' => { in_class = false; translated.push(ch); }
            '$' if !in_class => translated.push_str(r"\z"),
            '.' if !in_class && !scalar_pattern => return Err(ContractError::Unavailable("UTF-16 wildcard regex is unsupported".into())),
            '\\' => match chars.next() {
                Some('d') => translated.push_str(if in_class { "0-9" } else { "[0-9]" }),
                Some('/') => translated.push('/'),
                Some(c) if c.is_ascii_alphanumeric() && !matches!(c, 'n' | 'r' | 't')
                    && !(scalar_pattern && c == 'x') => {
                    return Err(ContractError::Unavailable(format!("unsupported portable regex escape: {c}")));
                }
                Some(c) => { translated.push('\\'); translated.push(c); }
                None => return Err(ContractError::Unavailable("unterminated regex escape".into())),
            },
            c => translated.push(c),
        }
    }
    regex::RegexBuilder::new(&translated).size_limit(4 * 1024 * 1024).dfa_size_limit(1024 * 1024)
        .build().map_err(|_| ContractError::Unavailable("unsupported or oversized portable regex".into()))
}
