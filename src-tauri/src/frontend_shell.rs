use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{Url, WebviewWindow};

pub const DEV_FRONTEND_PORT: u16 = 1420;
const SPLASH_FILE_NAME: &str = "hormachuelos-optimized-shell.html";
const PROBE_TIMEOUT: Duration = Duration::from_millis(200);
const POLL_EVERY: Duration = Duration::from_millis(250);
const WEBVIEW_READY: Duration = Duration::from_millis(500);
const WAIT_FOR_VITE: Duration = Duration::from_secs(120);

pub fn localhost_port_open(port: u16) -> bool {
    let host_port = format!("localhost:{port}");
    let resolved = host_port.to_socket_addrs().unwrap_or_default();
    let extras = [
        SocketAddr::from(([127, 0, 0, 1], port)),
        SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 1], port)),
    ];
    extras
        .into_iter()
        .chain(resolved)
        .any(|addr| TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).is_ok())
}

pub fn dev_frontend_url() -> Url {
    Url::parse("http://localhost:1420/").expect("static dev frontend URL")
}

pub fn is_dev_frontend_url(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    ) && url.port_or_known_default() == Some(DEV_FRONTEND_PORT)
        && matches!(url.scheme(), "http" | "https")
}

pub fn is_splash_url(url: &Url) -> bool {
    url.path().ends_with(SPLASH_FILE_NAME)
        || (url.scheme() == "data" && url.as_str().contains("Starting%20Hormachuelos%20Optimized"))
}

pub fn splash_data_url() -> Url {
    let encoded: String = splash_html()
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect();
    Url::parse(&format!("data:text/html;charset=utf-8,{encoded}")).expect("splash data URL")
}

pub fn splash_html() -> String {
    r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hormachuelos Optimized</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      background: #1e1e1e;
      color: #d7d7d7;
      font-family: "Segoe UI", sans-serif;
    }
    main {
      min-height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 2rem;
      box-sizing: border-box;
    }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 .6rem; }
    p { margin: 0; max-width: 28rem; line-height: 1.45; color: #b3b3b3; }
  </style>
</head>
<body>
  <main>
    <h1>Starting Hormachuelos Optimized</h1>
    <p>Waiting for the local UI on port 1420. Keep <code>npm run desktop:dev</code> running — this window will open the app as soon as that server is ready.</p>
  </main>
</body>
</html>
"#
    .to_string()
}

pub fn file_url_if_exists(path: &Path) -> Option<Url> {
    let path = path.canonicalize().ok()?;
    if !path.is_file() {
        return None;
    }
    Url::from_file_path(path).ok()
}

pub fn splash_file_url() -> Option<Url> {
    let path = std::env::temp_dir().join(SPLASH_FILE_NAME);
    std::fs::write(&path, splash_html()).ok()?;
    Url::from_file_path(path).ok()
}

/// Keep the main window off Edge's connection-refused page while Vite is
/// unavailable. Never fall back to a `file://` copy of `dist`: Tauri's CSP
/// blocks those styles/scripts, which leaves Skip to chat and empty tabs on
/// a black window. `cargo tauri dev` compiles without `custom-protocol`, so
/// the live shell is always http://localhost:1420.
pub fn recover_dev_frontend(window: WebviewWindow) {
    let _ = std::thread::Builder::new()
        .name("horma-frontend-shell".into())
        .spawn(move || recover_loop(window));
}

pub fn reload_dev_frontend(window: &WebviewWindow) {
    if localhost_port_open(DEV_FRONTEND_PORT) {
        let _ = window.navigate(dev_frontend_url());
    }
}

fn recover_loop(window: WebviewWindow) {
    // The main webview is still attaching during setup. Navigating immediately
    // can tear the window down and leave Edge's connection-refused page behind.
    std::thread::sleep(WEBVIEW_READY);
    if window.url().is_err() {
        return;
    }

    if localhost_port_open(DEV_FRONTEND_PORT) {
        open_dev_frontend(&window);
        return;
    }

    navigate_splash(&window);
    let deadline = Instant::now() + WAIT_FOR_VITE;
    while Instant::now() < deadline {
        std::thread::sleep(POLL_EVERY);
        if window.url().is_err() {
            return;
        }
        if localhost_port_open(DEV_FRONTEND_PORT) {
            open_dev_frontend(&window);
            return;
        }
        if !current_url(&window).is_some_and(|url| is_splash_url(&url)) {
            navigate_splash(&window);
        }
    }
}

fn open_dev_frontend(window: &WebviewWindow) {
    let _ = window.navigate(dev_frontend_url());
}

fn current_url(window: &WebviewWindow) -> Option<Url> {
    window.url().ok()
}

fn navigate_splash(window: &WebviewWindow) {
    if let Some(url) = splash_file_url() {
        let _ = window.navigate(url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::path::PathBuf;

    #[test]
    fn localhost_probe_sees_an_open_and_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe listener");
        let port = listener.local_addr().expect("listener address").port();
        assert!(localhost_port_open(port));
        drop(listener);
        assert!(!localhost_port_open(port));
    }

    #[test]
    fn identifies_the_vite_dev_url_and_splash_file() {
        assert!(is_dev_frontend_url(&dev_frontend_url()));
        assert!(is_dev_frontend_url(
            &Url::parse("http://localhost:1420/index.html").unwrap()
        ));
        assert!(is_dev_frontend_url(
            &Url::parse("http://127.0.0.1:1420/").unwrap()
        ));
        assert!(!is_dev_frontend_url(
            &Url::parse("http://127.0.0.1:3000/").unwrap()
        ));
        let splash = splash_data_url();
        assert!(is_splash_url(&splash));
        assert!(!is_splash_url(&dev_frontend_url()));
        let file_splash = Url::from_file_path(std::env::temp_dir().join(SPLASH_FILE_NAME))
            .unwrap_or_else(|_| {
                Url::parse("file:///tmp/hormachuelos-optimized-shell.html").unwrap()
            });
        assert!(is_splash_url(&file_splash));
    }

    #[test]
    fn file_dist_is_not_a_live_dev_frontend() {
        let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/index.html");
        if let Some(url) = file_url_if_exists(&dist) {
            assert!(
                !is_dev_frontend_url(&url),
                "file:// dist must not replace the Vite shell"
            );
        }
        assert_eq!(dev_frontend_url().scheme(), "http");
        assert_eq!(dev_frontend_url().host_str(), Some("localhost"));
    }

    #[test]
    fn splash_html_is_branded_and_writable() {
        let html = splash_html();
        assert!(html.contains("Starting Hormachuelos Optimized"));
        assert!(html.contains("1420"));
        assert!(is_splash_url(&splash_data_url()));
        let url = splash_file_url().expect("write splash html");
        assert!(is_splash_url(&url));
    }

    #[test]
    fn missing_dist_index_does_not_yield_a_url() {
        let missing = std::env::temp_dir().join(format!(
            "hormachuelos-missing-dist-{}.html",
            uuid::Uuid::new_v4()
        ));
        assert!(file_url_if_exists(&missing).is_none());
    }
}
