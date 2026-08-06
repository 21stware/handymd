//! Tauri commands — thin wrappers over the Vault.
//!
//! All commands operate on the shared Vault held in Tauri's managed state.
//! Errors are returned as strings so the frontend can render them.

use serde::Serialize;
use tauri::State;

use crate::db::{Note, NoteContent, Vault};
use crate::pdf;

#[derive(Debug, Serialize)]
pub struct VaultInfoDto {
    pub path: String,
    pub icloud: bool,
}

fn err_string(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn vault_info(vault: State<'_, Vault>) -> VaultInfoDto {
    VaultInfoDto {
        path: vault.info.path.to_string_lossy().to_string(),
        icloud: vault.info.icloud,
    }
}

#[tauri::command]
pub fn list_notes(vault: State<'_, Vault>) -> Result<Vec<Note>, String> {
    vault.list_notes().map_err(err_string)
}

#[tauri::command]
pub fn get_note(vault: State<'_, Vault>, id: String) -> Result<NoteContent, String> {
    vault.get_note(&id).map_err(err_string)
}

#[tauri::command]
pub fn create_note(vault: State<'_, Vault>) -> Result<Note, String> {
    vault.create_note().map_err(err_string)
}

#[tauri::command]
pub fn update_note(
    vault: State<'_, Vault>,
    id: String,
    content: String,
    title: String,
) -> Result<i64, String> {
    vault.update_note(&id, &title, &content).map_err(err_string)
}

#[tauri::command]
pub fn delete_note(vault: State<'_, Vault>, id: String) -> Result<(), String> {
    vault.delete_note(&id).map_err(err_string)
}

#[tauri::command]
pub fn set_note_pinned(vault: State<'_, Vault>, id: String, pinned: bool) -> Result<(), String> {
    vault.set_pinned(&id, pinned).map_err(err_string)
}

#[tauri::command]
pub fn save_image(
    vault: State<'_, Vault>,
    mime: String,
    blob: Vec<u8>,
) -> Result<String, String> {
    vault.save_image(&mime, blob).map_err(err_string)
}

#[tauri::command]
pub fn get_image(
    vault: State<'_, Vault>,
    id: String,
) -> Result<(String, Vec<u8>), String> {
    vault.get_image(&id).map_err(err_string)
}

#[tauri::command]
pub fn export_pdf(markdown: String, title: String, path: String) -> Result<(), String> {
    pdf::export_markdown_pdf(&markdown, &title, std::path::Path::new(&path)).map_err(err_string)
}

#[tauri::command]
pub fn export_markdown(markdown: String, path: String) -> Result<(), String> {
    std::fs::write(&path, markdown).map_err(err_string)
}
