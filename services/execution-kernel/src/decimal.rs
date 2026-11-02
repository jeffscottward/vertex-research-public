//! Internal bounded exact arithmetic. Public decimal validation remains native
//! ContractAuthority's job. Values outside i128 arithmetic capacity fail closed.
use crate::{KernelError, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{cmp::Ordering, fmt, str::FromStr};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub struct Decimal { coefficient: i128, scale: u32 }

impl Decimal {
    pub const ZERO: Self = Self { coefficient: 0, scale: 0 };
    pub const ONE: Self = Self { coefficient: 1, scale: 0 };

    fn normalized(mut coefficient: i128, mut scale: u32) -> Result<Self> {
        while scale > 0 && coefficient % 10 == 0 { coefficient /= 10; scale -= 1; }
        if scale > 18 { return Err(KernelError::Precision); }
        if coefficient==i128::MIN || coefficient.unsigned_abs().to_string().len().saturating_sub(scale as usize)>30 {
            return Err(KernelError::Overflow);
        }
        Ok(Self { coefficient, scale })
    }
    fn power(n: u32) -> Result<i128> { 10_i128.checked_pow(n).ok_or(KernelError::Overflow) }
    fn aligned(self, other: Self) -> Result<(i128, i128, u32)> {
        let scale = self.scale.max(other.scale);
        Ok((self.coefficient.checked_mul(Self::power(scale-self.scale)?).ok_or(KernelError::Overflow)?,
            other.coefficient.checked_mul(Self::power(scale-other.scale)?).ok_or(KernelError::Overflow)?, scale))
    }
    pub fn checked_add(self, rhs: Self) -> Result<Self> {
        let (a,b,scale) = self.aligned(rhs)?;
        Self::normalized(a.checked_add(b).ok_or(KernelError::Overflow)?, scale)
    }
    pub fn checked_sub(self, rhs: Self) -> Result<Self> { self.checked_add(rhs.checked_neg()?) }
    pub fn checked_neg(self) -> Result<Self> {
        Self::normalized(self.coefficient.checked_neg().ok_or(KernelError::Overflow)?, self.scale)
    }
    pub fn abs(self) -> Result<Self> { if self < Self::ZERO { self.checked_neg() } else { Ok(self) } }
    pub fn checked_mul(self, rhs: Self) -> Result<Self> {
        Self::normalized(self.coefficient.checked_mul(rhs.coefficient).ok_or(KernelError::Overflow)?, self.scale + rhs.scale)
    }
    pub fn from_u32(n: u32) -> Self { Self { coefficient: i128::from(n), scale: 0 } }
    pub fn is_integer(self) -> bool { self.scale == 0 }
    pub fn is_multiple_of(self, quantum: Self) -> Result<bool> {
        if quantum <= Self::ZERO { return Err(KernelError::InvalidDecimal); }
        let (a,b,_) = self.aligned(quantum)?;
        Ok(a.checked_rem(b).ok_or(KernelError::Overflow)? == 0)
    }
    /// Liability reservation only: upward to a positive currency quantum.
    pub fn ceil_to(self, quantum: Self) -> Result<Self> {
        if self < Self::ZERO || quantum <= Self::ZERO { return Err(KernelError::InvalidDecimal); }
        let (a,b,_) = self.aligned(quantum)?;
        let count = (a / b).checked_add(if a % b == 0 { 0 } else { 1 }).ok_or(KernelError::Overflow)?;
        Self::normalized(count.checked_mul(quantum.coefficient).ok_or(KernelError::Overflow)?, quantum.scale)
    }
}

impl FromStr for Decimal {
    type Err = KernelError;
    fn from_str(text: &str) -> Result<Self> {
        let body = text.strip_prefix('-').unwrap_or(text);
        let mut parts = body.split('.');
        let whole = parts.next().ok_or(KernelError::InvalidDecimal)?;
        let fraction = parts.next();
        if parts.next().is_some() || whole.is_empty() || whole.len() > 30 ||
            !whole.bytes().all(|b| b.is_ascii_digit()) || (whole.len() > 1 && whole.starts_with('0')) {
            return Err(KernelError::InvalidDecimal);
        }
        let fraction = match fraction {
            Some(s) if s.is_empty() || s.len() > 18 || s.ends_with('0') || !s.bytes().all(|b| b.is_ascii_digit()) => return Err(KernelError::InvalidDecimal),
            Some(s) => s,
            None => "",
        };
        let mut coefficient = 0_i128;
        for b in whole.bytes().chain(fraction.bytes()) {
            coefficient = coefficient.checked_mul(10).and_then(|c| c.checked_add(i128::from(b-b'0'))).ok_or(KernelError::Overflow)?;
        }
        if text.starts_with('-') {
            if coefficient == 0 { return Err(KernelError::InvalidDecimal); }
            coefficient = coefficient.checked_neg().ok_or(KernelError::Overflow)?;
        }
        Self::normalized(coefficient, fraction.len() as u32)
    }
}
impl fmt::Display for Decimal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let digits = self.coefficient.unsigned_abs().to_string();
        if self.coefficient < 0 { write!(f, "-")?; }
        let scale = self.scale as usize;
        if scale == 0 { write!(f, "{digits}") }
        else if digits.len() <= scale { write!(f, "0.{}{digits}", "0".repeat(scale-digits.len())) }
        else { write!(f, "{}.{}", &digits[..digits.len()-scale], &digits[digits.len()-scale..]) }
    }
}
impl Ord for Decimal {
    fn cmp(&self, rhs: &Self) -> Ordering {
        let sign = self.coefficient.signum().cmp(&rhs.coefficient.signum());
        if sign != Ordering::Equal { return sign; }
        // Compare magnitudes using bounded digit strings, without multiplying an
        // already-large coefficient by 10^18 merely to compare it.
        let left = self.coefficient.unsigned_abs().to_string();
        let right = rhs.coefficient.unsigned_abs().to_string();
        let left_exp = left.len() as i32 - self.scale as i32;
        let right_exp = right.len() as i32 - rhs.scale as i32;
        let mut cmp = left_exp.cmp(&right_exp);
        if cmp == Ordering::Equal {
            let width = left.len().max(right.len());
            cmp = left.bytes().chain(std::iter::repeat(b'0')).take(width)
                .cmp(right.bytes().chain(std::iter::repeat(b'0')).take(width));
        }
        if self.coefficient < 0 { cmp.reverse() } else { cmp }
    }
}
impl PartialOrd for Decimal { fn partial_cmp(&self, rhs: &Self) -> Option<Ordering> { Some(self.cmp(rhs)) } }
impl Serialize for Decimal {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok,S::Error> { s.serialize_str(&self.to_string()) }
}
impl<'de> Deserialize<'de> for Decimal {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self,D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}
