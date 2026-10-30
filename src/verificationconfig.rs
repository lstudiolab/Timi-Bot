//! Verification configuration validation.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds { pub pass:u32, pub review:u32 }
impl Default for Thresholds { fn default()->Self { Self { pass:80, review:60 } } }
impl Thresholds {
    pub fn validate(self)->Result<Self,&'static str> {
        if self.review > self.pass { return Err("Review threshold cannot exceed the pass threshold."); }
        if self.pass > 100 || self.review > 100 { return Err("Verification thresholds must be between 0 and 100."); }
        Ok(self)
    }
}
pub fn valid_snowflake(value:&str)->bool {
    (15..=22).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit())
}
