#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

const SERVICE: &str = "com.photonee.specreader";

/// Generate the keyring username for a given platform ID.
/// Each platform gets its own keyring entry: `llm_api_key_deepseek`, `llm_api_key_kimi`, etc.
fn username_for(platform_id: &str) -> String {
    format!("llm_api_key_{}", platform_id)
}

/// Abstraction over system-specific secure storage for LLM API keys.
/// Keys are stored per-platform, so switching platforms preserves each key.
pub trait ApiKeyStorage: Send + Sync {
    /// Store the API key for the given platform. An empty key should clear the entry.
    fn store(&self, platform_id: &str, api_key: &str) -> Result<(), String>;

    /// Retrieve the API key for the given platform, if any.
    fn retrieve(&self, platform_id: &str) -> Result<Option<String>, String>;

    /// Delete the API key for the given platform.
    fn delete(&self, platform_id: &str) -> Result<(), String>;
}

/// Production implementation backed by the OS keychain / credential manager.
pub struct KeyringStorage;

impl ApiKeyStorage for KeyringStorage {
    fn store(&self, platform_id: &str, api_key: &str) -> Result<(), String> {
        if api_key.is_empty() {
            return self.delete(platform_id);
        }
        let username = username_for(platform_id);
        let entry = keyring::Entry::new(SERVICE, &username)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
        entry
            .set_password(api_key)
            .map_err(|e| format!("Failed to store API key: {}", e))
    }

    fn retrieve(&self, platform_id: &str) -> Result<Option<String>, String> {
        let username = username_for(platform_id);
        let entry = keyring::Entry::new(SERVICE, &username)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => {
                // Backward compat: try the old single-key entry (llm_api_key without suffix)
                if platform_id == "deepseek" || platform_id == "openai" {
                    let legacy = keyring::Entry::new(SERVICE, "llm_api_key");
                    if let Ok(legacy_entry) = legacy {
                        if let Ok(password) = legacy_entry.get_password() {
                            // Migrate: store in new per-platform entry, delete old
                            let _ = self.store(platform_id, &password);
                            let _ = legacy_entry.delete_credential();
                            return Ok(Some(password));
                        }
                    }
                }
                Ok(None)
            }
            Err(e) => Err(format!("Failed to retrieve API key: {}", e)),
        }
    }

    fn delete(&self, platform_id: &str) -> Result<(), String> {
        let username = username_for(platform_id);
        match keyring::Entry::new(SERVICE, &username) {
            Ok(entry) => match entry.delete_credential() {
                Ok(_) => Ok(()),
                Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("Failed to delete API key: {}", e)),
            },
            Err(e) => Err(format!("Failed to create keyring entry: {}", e)),
        }
    }
}

/// In-memory storage for tests.
#[cfg(test)]
pub struct MemoryStorage {
    keys: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl MemoryStorage {
    pub fn new() -> Self {
        Self {
            keys: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
impl ApiKeyStorage for MemoryStorage {
    fn store(&self, platform_id: &str, api_key: &str) -> Result<(), String> {
        let mut keys = self.keys.lock().unwrap();
        if api_key.is_empty() {
            keys.remove(platform_id);
        } else {
            keys.insert(platform_id.to_string(), api_key.to_string());
        }
        Ok(())
    }

    fn retrieve(&self, platform_id: &str) -> Result<Option<String>, String> {
        Ok(self.keys.lock().unwrap().get(platform_id).cloned())
    }

    fn delete(&self, platform_id: &str) -> Result<(), String> {
        self.keys.lock().unwrap().remove(platform_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_storage_roundtrips_api_key_per_platform() {
        let storage = MemoryStorage::new();
        storage.store("deepseek", "sk-ds").unwrap();
        storage.store("kimi", "sk-km").unwrap();
        assert_eq!(storage.retrieve("deepseek").unwrap(), Some("sk-ds".to_string()));
        assert_eq!(storage.retrieve("kimi").unwrap(), Some("sk-km".to_string()));
    }

    #[test]
    fn memory_storage_deletes_on_empty_store() {
        let storage = MemoryStorage::new();
        storage.store("deepseek", "sk-ds").unwrap();
        storage.store("deepseek", "").unwrap();
        assert_eq!(storage.retrieve("deepseek").unwrap(), None);
    }

    #[test]
    fn memory_storage_delete_is_idempotent() {
        let storage = MemoryStorage::new();
        storage.delete("deepseek").unwrap();
        assert_eq!(storage.retrieve("deepseek").unwrap(), None);
    }

    #[test]
    fn memory_storage_platforms_are_independent() {
        let storage = MemoryStorage::new();
        storage.store("deepseek", "sk-ds").unwrap();
        // Deleting one platform doesn't affect another
        storage.delete("kimi").unwrap();
        assert_eq!(storage.retrieve("deepseek").unwrap(), Some("sk-ds".to_string()));
        assert_eq!(storage.retrieve("kimi").unwrap(), None);
    }
}
