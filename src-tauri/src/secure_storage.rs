#[cfg(test)]
use std::sync::Mutex;

const SERVICE: &str = "com.photonee.specreader";
const USERNAME: &str = "llm_api_key";

/// Abstraction over system-specific secure storage for the LLM API key.
pub trait ApiKeyStorage: Send + Sync {
    /// Store the API key securely. An empty key should clear any stored value.
    fn store(&self, api_key: &str) -> Result<(), String>;

    /// Retrieve the previously stored API key, if any.
    fn retrieve(&self) -> Result<Option<String>, String>;

    /// Delete the stored API key.
    fn delete(&self) -> Result<(), String>;
}

/// Production implementation backed by the OS keychain / credential manager.
pub struct KeyringStorage;

impl ApiKeyStorage for KeyringStorage {
    fn store(&self, api_key: &str) -> Result<(), String> {
        if api_key.is_empty() {
            return self.delete();
        }
        let entry = keyring::Entry::new(SERVICE, USERNAME)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
        entry
            .set_password(api_key)
            .map_err(|e| format!("Failed to store API key: {}", e))
    }

    fn retrieve(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, USERNAME)
            .map_err(|e| format!("Failed to create keyring entry: {}", e))?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Failed to retrieve API key: {}", e)),
        }
    }

    fn delete(&self) -> Result<(), String> {
        match keyring::Entry::new(SERVICE, USERNAME) {
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
    value: Mutex<Option<String>>,
}

#[cfg(test)]
impl MemoryStorage {
    pub fn new() -> Self {
        Self {
            value: Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl ApiKeyStorage for MemoryStorage {
    fn store(&self, api_key: &str) -> Result<(), String> {
        *self.value.lock().unwrap() = if api_key.is_empty() {
            None
        } else {
            Some(api_key.to_string())
        };
        Ok(())
    }

    fn retrieve(&self) -> Result<Option<String>, String> {
        Ok(self.value.lock().unwrap().clone())
    }

    fn delete(&self) -> Result<(), String> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_storage_roundtrips_api_key() {
        let storage = MemoryStorage::new();
        storage.store("sk-secret").unwrap();
        assert_eq!(storage.retrieve().unwrap(), Some("sk-secret".to_string()));
    }

    #[test]
    fn memory_storage_deletes_on_empty_store() {
        let storage = MemoryStorage::new();
        storage.store("sk-secret").unwrap();
        storage.store("").unwrap();
        assert_eq!(storage.retrieve().unwrap(), None);
    }

    #[test]
    fn memory_storage_delete_is_idempotent() {
        let storage = MemoryStorage::new();
        storage.delete().unwrap();
        assert_eq!(storage.retrieve().unwrap(), None);
    }
}
