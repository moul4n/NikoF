// NikoF display window — a thin Tauri shell that hosts the existing web
// `display` surface (frontend/display) in a native desktop window. It is a pure
// client: it never starts the backend or any sidecar (the ops dashboard owns
// those lifecycles). The window simply loads the frontend, which talks to the
// already-running backend over HTTP/SSE.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the NikoF display window");
}
