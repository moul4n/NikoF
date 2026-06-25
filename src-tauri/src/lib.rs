// NikoF display window — a thin Tauri shell that hosts the existing web
// `display` surface (frontend stage) in a native desktop window. It is a pure
// client: it never starts the backend or any sidecar. The window simply loads
// the frontend, which talks to the already-running backend over HTTP/SSE.
//
// The window is created here (rather than declaratively in tauri.conf.json) so
// its transparency can be chosen at launch. It defaults to TRANSPARENT (the
// see-through "floating avatar" look + the Transparent background option). The
// whole-frame flicker that originally looked like a transparency problem was
// actually a model-specific NaN being smeared by the bloom post pass (fixed in
// the renderer), so transparency is safe to keep on. NIKOF_STAGE_OPAQUE=1 forces
// an opaque window if a transparent WebView2 window ever misbehaves on a machine.

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let transparent = !env_flag("NIKOF_STAGE_OPAQUE");
    // Diagnostics for isolating the source of character flicker on the stage:
    //   NIKOF_STAGE_NO_POST=1    -> disable the bloom/SMAA/tone-map post chain
    //   NIKOF_STAGE_NO_SHADOWS=1 -> disable the shadow map + ground catcher
    let disable_post = env_flag("NIKOF_STAGE_NO_POST");
    let disable_shadows = env_flag("NIKOF_STAGE_NO_SHADOWS");

    // Expose launch flags to the frontend. __NIKOF_STAGE_TRANSPARENT__ lets the
    // WebGL renderer match the OS window (an opaque window needs an opaque,
    // no-alpha canvas or WebView2 composites the alpha channel and flickers).
    let init_script = format!(
        "window.__NIKOF_STAGE_TRANSPARENT__ = {}; window.__NIKOF_STAGE_NO_POST__ = {}; window.__NIKOF_STAGE_NO_SHADOWS__ = {};",
        transparent, disable_post, disable_shadows
    );

    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "display",
                tauri::WebviewUrl::App("stage/index.html".into()),
            )
            .title("NikoF")
            .inner_size(540.0, 960.0)
            .min_inner_size(360.0, 640.0)
            .resizable(true)
            .decorations(true)
            .transparent(transparent)
            .initialization_script(&init_script)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the NikoF display window");
}
