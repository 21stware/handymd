//! SQLite vault — `.mdb` is a renamed SQLite database.
//!
//! Schema:
//!   notes(id, title, content, created_at, updated_at)
//!   images(id, mime, blob, created_at)
//!   note_images(note_id, image_id)  — many/many link (future use)
//!   meta(key, value)                 — schema version etc.
//!
//! WAL is enabled for concurrency with iCloud's background sync daemon: reads
//! don't block the writer and vice versa. `PRAGMA synchronous = NORMAL` keeps
//! durability reasonable without the fsync cost of FULL on every keystroke save.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

use crate::vault::{ensure_parent, VaultInfo};

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("note not found: {0}")]
    NotFound(String),
}

type Result<T> = std::result::Result<T, DbError>;

#[derive(Debug, Serialize, Clone)]
pub struct Note {
    pub id: String,
    pub title: String,
    /// Plain-ish preview snippet for the note list (Bear-style subtitle).
    pub preview: String,
    pub updated_at: i64,
    pub pinned: bool,
}

#[derive(Debug, Serialize)]
pub struct NoteContent {
    pub id: String,
    pub content: String,
    pub updated_at: i64,
}

pub struct Vault {
    pub conn: Mutex<Connection>,
    pub info: VaultInfo,
}

const SCHEMA_VERSION: &str = "1";

impl Vault {
    pub fn open(info: VaultInfo) -> Result<Self> {
        ensure_parent(&info.path);
        let conn = Connection::open(&info.path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            info,
        })
    }

    pub fn list_notes(&self) -> Result<Vec<Note>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, COALESCE(title,''), COALESCE(content,''), updated_at, pinned \
             FROM notes ORDER BY pinned DESC, updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let title: String = row.get(1)?;
            let content: String = row.get(2)?;
            Ok(Note {
                id: row.get(0)?,
                title: title.clone(),
                preview: preview_from_content(&content, &title),
                updated_at: row.get(3)?,
                pinned: row.get::<_, i64>(4)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn get_note(&self, id: &str) -> Result<NoteContent> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, COALESCE(content,''), updated_at FROM notes WHERE id = ?1")?;
        let row = stmt
            .query_row(params![id], |row| {
                Ok(NoteContent {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .optional()?;
        row.ok_or(DbError::NotFound(id.to_string()))
    }

    pub fn create_note(&self) -> Result<Note> {
        let id = Uuid::new_v4().to_string();
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, content, created_at, updated_at) VALUES (?1, '', '', ?2, ?2)",
            params![id, now],
        )?;
        Ok(Note {
            id,
            title: String::new(),
            preview: String::new(),
            updated_at: now,
            pinned: false,
        })
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE notes SET pinned = ?1 WHERE id = ?2",
            params![i64::from(pinned), id],
        )?;
        if changed == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn update_note(&self, id: &str, title: &str, content: &str) -> Result<i64> {
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE notes SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
            params![title, content, now, id],
        )?;
        if changed == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(now)
    }

    pub fn delete_note(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn save_image(&self, mime: &str, blob: Vec<u8>) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = now_secs();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO images (id, mime, blob, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, mime, blob, now],
        )?;
        Ok(id)
    }

    pub fn get_image(&self, id: &str) -> Result<(String, Vec<u8>)> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT mime, blob FROM images WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?;
        row.ok_or(DbError::NotFound(id.to_string()))
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Strip light markdown chrome and return a short list preview (skip the title line).
fn preview_from_content(content: &str, title: &str) -> String {
    let mut out = String::new();
    let title_norm = title.trim();
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let mut plain = t
            .trim_start_matches('#')
            .trim_start()
            .trim_start_matches(['-', '*', '+', '>'])
            .trim_start();
        // Todo prefix survives the bullet strip above (`- [x] text` → `[x] text`).
        if let Some(rest) = plain
            .strip_prefix("[ ] ")
            .or_else(|| plain.strip_prefix("[x] "))
            .or_else(|| plain.strip_prefix("[X] "))
        {
            plain = rest;
        }
        let plain = plain
            .replace("**", "")
            .replace("__", "")
            .replace("~~", "")
            .replace("==", "")
            .replace('`', "");
        if plain.is_empty() {
            continue;
        }
        if out.is_empty() && !title_norm.is_empty() && plain == title_norm {
            continue; // skip the title line itself
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&plain);
        if out.len() >= 120 {
            break;
        }
    }
    if out.len() > 100 {
        out.truncate(100);
        out.push('…');
    }
    out
}

fn init_schema(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS notes (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL DEFAULT '',
          content     TEXT NOT NULL DEFAULT '',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL,
          pinned      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes(updated_at DESC);

        CREATE TABLE IF NOT EXISTS images (
          id          TEXT PRIMARY KEY,
          mime        TEXT NOT NULL,
          blob        BLOB NOT NULL,
          created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS note_images (
          note_id   TEXT NOT NULL,
          image_id  TEXT NOT NULL,
          PRIMARY KEY (note_id, image_id),
          FOREIGN KEY (note_id)  REFERENCES notes(id)  ON DELETE CASCADE,
          FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        "#,
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?1)",
        params![SCHEMA_VERSION],
    )?;
    tx.commit()?;
    add_missing_columns(conn)?;
    Ok(())
}

/// SQLite has no `ADD COLUMN IF NOT EXISTS`, so probe `table_info` first.
/// Vaults created before a column existed are upgraded in place.
fn add_missing_columns(conn: &Connection) -> Result<()> {
    let mut existing = Vec::new();
    {
        let mut stmt = conn.prepare("PRAGMA table_info(notes)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        for r in rows {
            existing.push(r?);
        }
    }
    for (name, ddl) in [("pinned", "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")]
    {
        if !existing.iter().any(|c| c == name) {
            conn.execute_batch(ddl)?;
        }
    }
    Ok(())
}
