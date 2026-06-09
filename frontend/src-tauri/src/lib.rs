mod session;
mod tavus;
mod wake_word;

use session::SessionState;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(tavus::AppState::default())
    .manage(SessionState::default())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Menu-bar tray so Jarvus stays alive in the background while listening.
      let open = MenuItemBuilder::with_id("open", "Open Jarvus").build(app)?;
      let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
      let menu = MenuBuilder::new(app).items(&[&open, &quit]).build()?;
      let _tray = TrayIconBuilder::with_id("jarvus-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
          "open" => {
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
          "quit" => app.exit(0),
          _ => {}
        })
        .build(app)?;

      // Begin listening for "Hey Jarvus" (no-op without the wake-word feature).
      wake_word::spawn_wake_word_listener(app.handle().clone());
      Ok(())
    })
    // Closing the window hides it (app keeps listening in the tray) rather than quitting.
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.hide();
        api.prevent_close();
      }
    })
    .invoke_handler(tauri::generate_handler![
      tavus::create_conversation,
      tavus::end_conversation,
      session::start_session,
      session::reset_idle_timer,
      session::end_session
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
