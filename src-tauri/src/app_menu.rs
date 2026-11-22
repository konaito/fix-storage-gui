//! macOS のアプリメニュー（「Fix Storage GUI」メニュー）に「アップデートを確認…」を足す。
//! 標準メニュー（Menu::default）はそのまま使い、「Fix Storage GUI について」の直後に 1 項目だけ挿入する。
//! 選ばれたらフロントエンドへ `check-for-updates` イベントを送り、実際の確認は updater プラグイン（JS 側）が行う。

use tauri::menu::{Menu, MenuItem};
use tauri::{App, Emitter, Runtime};

pub const CHECK_UPDATES_ID: &str = "check-for-updates";
pub const CHECK_UPDATES_EVENT: &str = "check-for-updates";

pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let handle = app.handle();
    let menu = Menu::default(handle)?;
    let item = MenuItem::with_id(handle, CHECK_UPDATES_ID, "アップデートを確認…", true, None::<&str>)?;
    // 先頭のサブメニューが macOS のアプリメニュー。0 番目は「〜について」。
    if let Some(app_menu) = menu.items()?.into_iter().next().and_then(|k| k.as_submenu().cloned()) {
        app_menu.insert(&item, 1)?;
    } else {
        menu.append(&item)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == CHECK_UPDATES_ID {
            let _ = app.emit(CHECK_UPDATES_EVENT, ());
        }
    });
    Ok(())
}
