use crate::{KernelError, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

pub const SECOND_NS: i128 = 1_000_000_000;
pub const DAY_NS: i128 = 86_400 * SECOND_NS;

/// Integer epoch/duration nanoseconds are strings on the internal JSON wire.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct Ns(pub i128);
impl Ns {
    pub fn checked_add(self, rhs: Self) -> Result<Self> { self.0.checked_add(rhs.0).map(Self).ok_or(KernelError::Overflow) }
}
impl Serialize for Ns {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok,S::Error> { s.serialize_str(&self.0.to_string()) }
}
impl<'de> Deserialize<'de> for Ns {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self,D::Error> {
        let s = String::deserialize(d)?;
        if s.is_empty() || (s.len()>1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(serde::de::Error::custom("nonnegative exact nanoseconds required"));
        }
        s.parse::<i128>().map(Self).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct CivilDate { year: i32, month: u32, day: u32 }
impl CivilDate {
    pub fn parse(text: &str) -> Result<Self> {
        let b = text.as_bytes();
        if b.len()!=10 || b[4]!=b'-' || b[7]!=b'-' || !b.iter().enumerate().all(|(i,v)| i==4 || i==7 || v.is_ascii_digit()) {
            return Err(KernelError::CalendarProof);
        }
        let year = text[..4].parse::<i32>().map_err(|_| KernelError::CalendarProof)?;
        let month = text[5..7].parse::<u32>().map_err(|_| KernelError::CalendarProof)?;
        let day = text[8..].parse::<u32>().map_err(|_| KernelError::CalendarProof)?;
        let leap = year%4==0 && (year%100!=0 || year%400==0);
        let max = match month { 1|3|5|7|8|10|12=>31, 4|6|9|11=>30, 2 if leap=>29, 2=>28, _=>0 };
        if year<1970 || day==0 || day>max { return Err(KernelError::CalendarProof); }
        Ok(Self { year, month, day })
    }
    pub fn epoch_day(self) -> i128 {
        let y = i128::from(self.year) - if self.month<=2 {1} else {0};
        let era = y.div_euclid(400);
        let yoe = y-era*400;
        let m = i128::from(self.month) + if self.month>2 {-3} else {9};
        let doy = (153*m+2)/5+i128::from(self.day)-1;
        era*146097+yoe*365+yoe/4-yoe/100+doy-719468
    }
    pub fn instant(self, minute: u16, offset_seconds: i32) -> Result<Ns> {
        if minute>=1440 || !(-64800..=64800).contains(&offset_seconds) { return Err(KernelError::CalendarProof); }
        Ok(Ns(self.epoch_day()*DAY_NS + i128::from(minute)*60*SECOND_NS-i128::from(offset_seconds)*SECOND_NS))
    }
}
impl fmt::Display for CivilDate {
    fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { write!(f,"{:04}-{:02}-{:02}",self.year,self.month,self.day) }
}
impl Serialize for CivilDate {
    fn serialize<S: Serializer>(&self,s:S)->std::result::Result<S::Ok,S::Error> { s.serialize_str(&self.to_string()) }
}
impl<'de> Deserialize<'de> for CivilDate {
    fn deserialize<D: Deserializer<'de>>(d:D)->std::result::Result<Self,D::Error> {
        Self::parse(&String::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OffsetInterval { pub start_ns: Ns, pub end_ns: Ns, pub offset_seconds: i32 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub date: CivilDate, pub tradable: bool, pub open_minute: u16,
    pub close_minute: u16, pub entry_cutoff_minute: u16,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExchangeCalendar {
    pub calendar_id: String, pub version: String, pub timezone: String, pub tzdb_version: String,
    pub intervals: Vec<OffsetInterval>, pub sessions: Vec<Session>,
}
#[derive(Clone, Copy, Debug)]
pub struct EntryWindow { pub date: CivilDate, pub open_ns: Ns, pub cutoff_ns: Ns, pub close_ns: Ns }
impl ExchangeCalendar {
    pub fn validate(&self) -> Result<()> {
        if [&self.calendar_id,&self.version,&self.timezone,&self.tzdb_version].iter().any(|s| s.is_empty()) ||
            self.intervals.is_empty() || self.intervals.len()>512 || self.sessions.is_empty() || self.sessions.len()>512 {
            return Err(KernelError::CalendarProof);
        }
        for (i, v) in self.intervals.iter().enumerate() {
            if v.start_ns.0<0 || v.start_ns>=v.end_ns || !(-64800..=64800).contains(&v.offset_seconds) ||
                (i>0 && self.intervals[i-1].end_ns!=v.start_ns) { return Err(KernelError::CalendarProof); }
        }
        for (i,s) in self.sessions.iter().enumerate() {
            if s.open_minute>=s.entry_cutoff_minute || s.entry_cutoff_minute>s.close_minute || s.close_minute>=1440 ||
                (i>0 && self.sessions[i-1].date>=s.date) { return Err(KernelError::CalendarProof); }
        }
        Ok(())
    }
    pub fn local_date(&self, now: Ns) -> Result<CivilDate> {
        self.validate()?;
        let interval = self.intervals.iter().find(|i|i.start_ns<=now && now<i.end_ns).ok_or(KernelError::CalendarProof)?;
        let local = now.0.checked_add(i128::from(interval.offset_seconds)*SECOND_NS).ok_or(KernelError::Overflow)?;
        self.sessions.iter().find(|s| s.date.epoch_day()==local.div_euclid(DAY_NS)).map(|s|s.date).ok_or(KernelError::CalendarProof)
    }
    /// Proves a unique conversion using an immutable, policy-pinned transition
    /// table. Spring gaps/fall folds are rejected, never guessed by host tzdata.
    pub fn local_instant(&self, date: CivilDate, minute: u16) -> Result<Ns> {
        self.validate()?;
        let mut found = None;
        for interval in &self.intervals {
            let candidate = date.instant(minute, interval.offset_seconds)?;
            if interval.start_ns<=candidate && candidate<interval.end_ns {
                if found.is_some() { return Err(KernelError::CalendarProof); }
                found = Some(candidate);
            }
        }
        found.ok_or(KernelError::CalendarProof)
    }
    pub fn entry(&self, now: Ns) -> Result<EntryWindow> {
        let date = self.local_date(now)?;
        let session = self.sessions.iter().find(|s|s.date==date).ok_or(KernelError::CalendarProof)?;
        if !session.tradable { return Err(KernelError::SessionClosed); }
        let window = EntryWindow { date, open_ns: self.local_instant(date, session.open_minute)?,
            cutoff_ns: self.local_instant(date,session.entry_cutoff_minute)?, close_ns: self.local_instant(date,session.close_minute)? };
        if window.open_ns>=window.cutoff_ns || window.cutoff_ns>window.close_ns || now<window.open_ns || now>=window.cutoff_ns {
            return Err(KernelError::SessionClosed);
        }
        Ok(window)
    }
}

pub fn fresh(observed: Ns, now: Ns, maximum_age: Ns) -> Result<()> {
    if observed.0<0 || maximum_age.0<0 || observed>now || now.0.checked_sub(observed.0).ok_or(KernelError::Overflow)?>maximum_age.0 {
        return Err(KernelError::StaleObservation);
    }
    Ok(())
}
