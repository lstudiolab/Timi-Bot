//! Runtime helpers shared by gateway event dispatch.
use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct TimedEvent { pub at:Instant, pub fingerprint:String }
#[derive(Debug, Default)]
pub struct EventWindow { events:VecDeque<TimedEvent> }
impl EventWindow {
    pub fn push(&mut self, fingerprint:String, now:Instant, window:Duration) {
        self.prune(now, window);
        self.events.push_back(TimedEvent { at:now, fingerprint });
    }
    pub fn prune(&mut self, now:Instant, window:Duration) {
        while self.events.front().is_some_and(|event| now.duration_since(event.at)>window) { self.events.pop_front(); }
    }
    pub fn count(&self)->usize { self.events.len() }
}
pub fn normalize_message(input:&str)->String {
    input.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn jaccard_similarity(a:&str,b:&str)->f64 {
    let left=normalize_message(a).split_whitespace().map(str::to_owned).collect::<std::collections::HashSet<_>>();
    let right=normalize_message(b).split_whitespace().map(str::to_owned).collect::<std::collections::HashSet<_>>();
    if left.is_empty() && right.is_empty() { return 1.0; }
    let intersection=left.intersection(&right).count();
    let union=left.union(&right).count();
    if union==0 { 0.0 } else { intersection as f64 / union as f64 }
}
