// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Preserve the default panic behavior while also writing panic information
    // to the application log file. This is especially important in release
    // builds where users may not otherwise be able to report what went wrong.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("Application panic: {}", info);
        if let Some(location) = info.location() {
            log::error!(
                "Panic location: {}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            );
        }
        default_hook(info);
    }));

    app_lib::run();
}
