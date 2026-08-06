mod commands;
mod db;
mod pdf;
mod vault;

use vault::resolve_vault;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let info = match resolve_vault() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("vault resolve failed: {e}");
            std::process::exit(1);
        }
    };
    let vault = match db::Vault::open(info) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("vault open failed: {e}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(vault)
        .invoke_handler(tauri::generate_handler![
            commands::vault_info,
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::update_note,
            commands::delete_note,
            commands::set_note_pinned,
            commands::save_image,
            commands::get_image,
            commands::export_pdf,
            commands::export_markdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running handymd");
}
