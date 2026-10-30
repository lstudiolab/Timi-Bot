//! Risk scoring primitives for in-Discord verification.
#[derive(Debug, Clone, Copy)]
pub struct Weights { pub age:u32, pub history:u32, pub attempts:u32, pub behavior:u32, pub avatar:u32 }
impl Default for Weights { fn default()->Self { Self { age:40,history:20,attempts:20,behavior:10,avatar:10 } } }
#[derive(Debug, Clone)]
pub struct Signal { pub points:u32, pub maximum:u32, pub passed:bool, pub reason:String, pub critical:bool }
fn clamp(value:f64,max:u32)->u32 { value.round().max(0.0).min(max as f64) as u32 }
pub fn score_age(age_days:f64, minimum_days:u64, maximum:u32)->Signal {
    if age_days<minimum_days as f64 { return Signal { points:0,maximum,passed:false,
        reason:format!("Account is {:.1} days old; minimum is {} days.",age_days,minimum_days),critical:true }; }
    let fraction=if minimum_days==0 || age_days/minimum_days.max(1) as f64>=4.0 {1.0}
        else if age_days/minimum_days as f64>=2.0 {0.95}
        else if age_days/minimum_days as f64>=1.5 {0.9}
        else if age_days/minimum_days as f64>=1.2 {0.8} else {0.7};
    Signal { points:clamp(maximum as f64*fraction,maximum),maximum,passed:true,
        reason:format!("Account age: {:.1} days; minimum: {} days.",age_days,minimum_days),critical:false }
}
pub fn score_history(joins:u64,leaves:u64,failed_checks:u64,maximum:u32)->Signal {
    let penalty=((leaves.saturating_sub(1)) as f64*maximum as f64*0.2+failed_checks as f64*maximum as f64*0.15).min(maximum as f64);
    Signal { points:maximum-clamp(penalty,maximum),maximum,passed:penalty==0.0,
        reason:format!("{} recorded join(s), {} leave(s), {} prior failed assessment(s).",joins,leaves,failed_checks),critical:false }
}
pub fn score_attempts(count:usize,maximum:u32)->Signal {
    let fraction=match count {0|1=>1.0,2=>0.9,3=>0.8,4|5=>0.7,_=>0.6};
    Signal { points:clamp(maximum as f64*fraction,maximum),maximum,passed:count<=1,
        reason:format!("{} verification attempt(s) in the last 10 minutes.",count),critical:false }
}
pub fn score_behavior(count:u64,recent:bool,reason:&str,maximum:u32)->Signal {
    let fraction=match count {0=>1.0,1=>0.65,2|3=>0.3,_=>0.0};
    Signal { points:clamp(maximum as f64*fraction,maximum),maximum,passed:!recent&&count==0,
        reason:format!("{} suspicious message event(s) recorded.{}",count,if recent&&!reason.is_empty(){format!(" Latest: {}",reason)}else{String::new()}),critical:false }
}
pub fn score_avatar(has_custom_avatar:bool,maximum:u32)->Signal {
    Signal { points:if has_custom_avatar{maximum}else{clamp(maximum as f64*0.25,maximum)},maximum,
        passed:has_custom_avatar,reason:if has_custom_avatar{"Custom avatar present."}else{"Default Discord avatar detected; this is a weak signal only."}.into(),critical:false }
}
pub fn outcome(score:u32,pass:u32,review:u32,critical_age_failure:bool)->&'static str {
    if critical_age_failure {"review"} else if score>=pass {"pass"} else if score>=review {"review"} else {"reject"}
}
