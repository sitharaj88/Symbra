//! Sample crate module for the Rust extractor.

use std::collections::HashMap;
use std::env;
use crate::store::{Store, open as open_store};
use super::util::*;
use serde::Serialize as Ser;

mod config;
pub mod models {
    pub struct Model;
}

/// Maximum retries.
pub const MAX_RETRIES: u32 = 3;

static COUNTER: i32 = 0;

/// Alias for ids.
pub type Id = u64;

/// A user.
#[derive(Debug, Clone)]
pub struct User {
    /// The id.
    pub id: Id,
    name: String,
    cache: Cache,
}

pub struct Cache(HashMap<String, String>);

/// Roles.
pub enum Role {
    /// Admin role.
    Admin,
    Member { level: u8 },
    Guest(String),
}

/// Something findable.
pub trait Repo {
    /// Find by id.
    fn find(&self, id: Id) -> Option<User>;
    fn close(&mut self) {}
}

impl User {
    /// Construct a user.
    pub fn new(name: &str) -> Self {
        let cache = Cache::default();
        User { id: 0, name: name.to_string(), cache }
    }

    pub fn greet(&self, prefix: &str) -> String {
        self.save();
        format!("{}{}", prefix, self.name)
    }

    fn save(&self) {}
}

impl Repo for Cache {
    fn find(&self, id: Id) -> Option<User> {
        let store: Store = open_store();
        let user = User::new("x");
        let other = User { id: 1, name: String::new(), cache: Cache::default() };
        let svc = store::Service::new();
        svc.run();
        store.close();
        other.greet("hi");
        crate::util::helper(id);
        Some(user)
    }
}

impl<T: Clone> Ser for Wrapper<T> {}

/// Generic map.
pub fn map_all<T, U>(xs: Vec<T>, f: impl Fn(T) -> U) -> Vec<U> {
    xs.into_iter().map(f).collect()
}

pub async fn helper(id: Id) -> Result<(), Box<dyn std::error::Error>> {
    let token = env::var("API_TOKEN")?;
    let debug = std::env::var("DEBUG").ok();
    let _ = std::env::var_os("HOME");
    println!("{} {:?} {}", token, debug, id);
    Ok(())
}

macro_rules! square {
    ($x:expr) => {
        $x * $x
    };
}

#[test]
fn greet_works() {
    let u = User::new("a");
    assert_eq!(u.greet("b"), "ba");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_works() {
        let c = Cache::default();
        assert!(c.find(1).is_none());
    }
}
