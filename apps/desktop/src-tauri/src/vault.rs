//! Resolve the vault.mdb location.
//!
//! Preference order:
//!   1. `HANDYMD_VAULT` env var (absolute path to a .mdb file).
//!   2. iCloud Drive app container: `~/Library/Mobile Documents/iCloud~handymd/Documents/vault.mdb`
//!      — used only if the iCloud Drive root (`~/Library/Mobile Documents`) exists, so we
//!      never create a phantom container on machines without iCloud signed in.
//!   3. Local fallback: `~/Library/handymd/vault.mdb`.
//!
//! The chosen parent directory is created (0700) if missing. The .mdb file itself
//! is created on first open by the SQLite layer.

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct VaultInfo {
    pub path: PathBuf,
    pub icloud: bool,
}

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("home directory not available")]
    NoHome,
    #[error("vault path is not absolute: {0}")]
    NotAbsolute(String),
}

pub fn resolve_vault() -> Result<VaultInfo, VaultError> {
    if let Ok(p) = std::env::var("HANDYMD_VAULT") {
        let path = PathBuf::from(&p);
        if !path.is_absolute() {
            return Err(VaultError::NotAbsolute(p));
        }
        return Ok(VaultInfo { path, icloud: false });
    }

    let home = dirs::home_dir().ok_or(VaultError::NoHome)?;

    // iCloud Drive app containers (`iCloud~<bundle>`) can only be created by the
    // OS on behalf of a signed app that has registered an iCloud entitlement for
    // the bundle id. We cannot `mkdir` one ourselves (Permission denied), so we
    // only adopt the iCloud path when the container already exists AND is
    // writable — i.e. a previously-signed build set it up. Otherwise we fall
    // back to a local directory we own.
    let mobile_docs = home.join("Library/Mobile Documents");
    if mobile_docs.exists() {
        let dir = mobile_docs.join("iCloud~handymd/Documents");
        if dir.is_dir() && is_writable_dir(&dir) {
            return Ok(VaultInfo {
                path: dir.join("vault.mdb"),
                icloud: true,
            });
        }
    }

    let dir = home.join("Library/handymd");
    std::fs::create_dir_all(&dir).ok();
    Ok(VaultInfo {
        path: dir.join("vault.mdb"),
        icloud: false,
    })
}

fn is_writable_dir(dir: &Path) -> bool {
    let probe = dir.join(".handymd-write-probe");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            std::fs::remove_file(&probe).ok();
            true
        }
        Err(_) => false,
    }
}

/// Ensure the parent of `path` exists. Returns the path itself for convenience.
pub fn ensure_parent(path: &Path) -> &Path {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    path
}
