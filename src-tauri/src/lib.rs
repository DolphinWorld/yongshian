use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const LOCAL_SHARE_PORT: u16 = 4173;
static LOCAL_SHARE_SERVER: OnceLock<Result<(), String>> = OnceLock::new();
static PROVIDER_KEYS: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            http_request,
            provider_request,
            provider_key_statuses,
            save_provider_key,
            clear_provider_key,
            tailscale_info,
            tailscale_serve
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Council");
}

#[derive(serde::Deserialize)]
struct HttpRequest {
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
}

#[derive(serde::Serialize)]
struct HttpResponse {
    status: u16,
    status_text: String,
    body: String,
}

#[derive(serde::Deserialize)]
struct ProviderRequest {
    provider_id: String,
    url: String,
    method: String,
    headers: std::collections::HashMap<String, String>,
    body: Option<String>,
}

#[derive(serde::Serialize)]
struct TailscaleInfo {
    installed: bool,
    authenticated: bool,
    ip4: Option<String>,
    dns_name: Option<String>,
    serve_url: Option<String>,
    message: String,
}

#[tauri::command]
async fn http_request(request: HttpRequest) -> Result<HttpResponse, String> {
    let url = reqwest::Url::parse(&request.url).map_err(|error| error.to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Only http and https requests are supported.".to_string());
    }

    let client = reqwest::Client::new();
    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|error| error.to_string())?;
    let mut builder = client.request(method, url);

    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }

    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let body = response.text().await.map_err(|error| error.to_string())?;

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text,
        body,
    })
}

#[tauri::command]
async fn provider_request(request: ProviderRequest) -> Result<HttpResponse, String> {
    perform_provider_request(request).await
}

#[tauri::command]
fn provider_key_statuses() -> Result<std::collections::HashMap<String, bool>, String> {
    let keys = provider_keys().lock().map_err(|error| error.to_string())?;
    Ok(keys
        .iter()
        .map(|(provider, key)| (provider.clone(), !key.trim().is_empty()))
        .collect())
}

#[tauri::command]
fn save_provider_key(provider_id: String, key: String) -> Result<(), String> {
    let mut keys = provider_keys().lock().map_err(|error| error.to_string())?;
    keys.insert(provider_id, key);
    save_provider_keys(&keys)
}

#[tauri::command]
fn clear_provider_key(provider_id: String) -> Result<(), String> {
    let mut keys = provider_keys().lock().map_err(|error| error.to_string())?;
    keys.remove(&provider_id);
    save_provider_keys(&keys)
}

async fn perform_provider_request(request: ProviderRequest) -> Result<HttpResponse, String> {
    validate_provider_url(&request.provider_id, &request.url)?;
    let key = provider_key(&request.provider_id)
        .ok_or_else(|| format!("Missing API key for {} on the Mac.", request.provider_id))?;
    let url = request.url.replace("__PROVIDER_API_KEY__", &url_encode(&key));

    let client = reqwest::Client::new();
    let method = request
        .method
        .parse::<reqwest::Method>()
        .map_err(|error| error.to_string())?;
    let mut builder = client.request(method, url);

    for (name, value) in request.headers {
        builder = builder.header(name, value.replace("__PROVIDER_API_KEY__", &key));
    }

    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("").to_string();
    let body = response.text().await.map_err(|error| error.to_string())?;

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text,
        body,
    })
}

fn validate_provider_url(provider_id: &str, request_url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(request_url).map_err(|error| error.to_string())?;
    if url.scheme() != "https" {
        return Err("Cloud provider requests must use HTTPS.".to_string());
    }

    let Some(host) = url.host_str() else {
        return Err("Provider request URL is missing a host.".to_string());
    };

    let allowed_host = match provider_id {
        "openai" => "api.openai.com",
        "anthropic" => "api.anthropic.com",
        "google" => "generativelanguage.googleapis.com",
        "deepseek" => "api.deepseek.com",
        _ => return Err(format!("Provider {provider_id} is not supported by the Mac relay.")),
    };

    if host == allowed_host {
        Ok(())
    } else {
        Err(format!(
            "Provider {provider_id} requests can only be sent to {allowed_host}."
        ))
    }
}

fn provider_key(provider_id: &str) -> Option<String> {
    provider_keys()
        .lock()
        .ok()
        .and_then(|keys| keys.get(provider_id).cloned())
        .filter(|key| !key.trim().is_empty())
}

fn provider_keys() -> &'static Mutex<std::collections::HashMap<String, String>> {
    PROVIDER_KEYS.get_or_init(|| Mutex::new(load_provider_keys()))
}

fn provider_key_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Yongshian")
            .join("provider-keys.json"),
    )
}

fn load_provider_keys() -> std::collections::HashMap<String, String> {
    let Some(path) = provider_key_path() else {
        return std::collections::HashMap::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_provider_keys(keys: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let Some(path) = provider_key_path() else {
        return Err("Unable to find local app data directory.".to_string());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string(keys).map_err(|error| error.to_string())?;
    std::fs::write(path, content).map_err(|error| error.to_string())
}

fn url_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[tauri::command]
fn tailscale_info() -> Result<TailscaleInfo, String> {
    let Some(binary) = find_tailscale_binary() else {
        return Ok(TailscaleInfo {
            installed: false,
            authenticated: false,
            ip4: None,
            dns_name: None,
            serve_url: None,
            message: "Tailscale is not installed on this Mac.".to_string(),
        });
    };

    let status_output = std::process::Command::new(&binary)
        .args(["status", "--json"])
        .output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&status_output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&status_output.stderr).trim().to_string();

    if !status_output.status.success() {
        return Ok(TailscaleInfo {
            installed: true,
            authenticated: false,
            ip4: None,
            dns_name: None,
            serve_url: None,
            message: if stderr.is_empty() {
                "Tailscale is installed, but status is not available. Open Tailscale and sign in, then check again.".to_string()
            } else {
                stderr
            },
        });
    }

    let status_json: serde_json::Value = match serde_json::from_slice(&status_output.stdout) {
        Ok(value) => value,
        Err(_) => {
            let detail = if stdout.is_empty() {
                stderr
            } else {
                stdout.chars().take(180).collect()
            };
            let suffix = if detail.is_empty() {
                "".to_string()
            } else {
                format!(" Details: {detail}")
            };
            return Ok(TailscaleInfo {
                installed: true,
                authenticated: false,
                ip4: None,
                dns_name: None,
                serve_url: None,
                message: format!(
                    "Tailscale is installed, but its status output could not be read. Open Tailscale and sign in, then check again.{suffix}"
                ),
            });
        }
    };
    let backend_state = status_json
        .get("BackendState")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let authenticated = backend_state == "Running";
    let dns_name = status_json
        .get("Self")
        .and_then(|value| value.get("DNSName"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim_end_matches('.').to_string());
    let ip4 = tailscale_ip4(&binary);
    let serve_url = tailscale_serve_url(&binary).or_else(|| preferred_private_url(dns_name.as_deref(), ip4.as_deref()));
    let message = if authenticated {
        "Tailscale ready. Press Share App to create a private iPhone QR code.".to_string()
    } else {
        format!("Tailscale installed, but state is {backend_state}. Sign in from the Tailscale app.")
    };

    Ok(TailscaleInfo {
        installed: true,
        authenticated,
        ip4,
        dns_name,
        serve_url,
        message,
    })
}

#[tauri::command]
async fn tailscale_serve() -> Result<TailscaleInfo, String> {
    tauri::async_runtime::spawn_blocking(tailscale_serve_impl)
        .await
        .map_err(|error| error.to_string())?
}

fn tailscale_serve_impl() -> Result<TailscaleInfo, String> {
    let Some(binary) = find_tailscale_binary() else {
        return Err("Tailscale is not installed on this Mac.".to_string());
    };

    ensure_local_app_server();

    let output = run_command_with_timeout(
        &binary,
        &[
            "serve",
            "--bg",
            "--yes",
            &format!("http://127.0.0.1:{LOCAL_SHARE_PORT}"),
        ],
        Duration::from_secs(6),
    )?;

    if output.timed_out {
        return Err(format!(
            "{}\n\nAfter enabling Tailscale Serve, click Share App again.",
            output.message_or("Tailscale Serve did not finish configuring.")
        ));
    }

    if !output.status.success() {
        return Err(output.message_or("Unable to configure Tailscale Serve."));
    }

    let mut info = tailscale_info()?;
    info.serve_url = tailscale_serve_url(&binary).or(info.serve_url);
    if info.authenticated {
        info.message = "Private access ready. Scan the QR code from your iPhone after Tailscale is connected.".to_string();
    }
    Ok(info)
}

struct CommandResult {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

impl CommandResult {
    fn message_or(&self, fallback: &str) -> String {
        let combined = [self.stdout.trim(), self.stderr.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if combined.is_empty() {
            fallback.to_string()
        } else {
            combined
        }
    }
}

#[cfg(unix)]
fn timeout_exit_status() -> std::process::ExitStatus {
    use std::os::unix::process::ExitStatusExt;
    std::process::ExitStatus::from_raw(124 << 8)
}

#[cfg(not(unix))]
fn timeout_exit_status() -> std::process::ExitStatus {
    std::process::Command::new("false")
        .status()
        .unwrap_or_else(|_| panic!("unable to construct timeout status"))
}

fn run_command_with_timeout(
    binary: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<CommandResult, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let stdout_path = std::env::temp_dir().join(format!("yongshian-tailscale-{stamp}.out"));
    let stderr_path = std::env::temp_dir().join(format!("yongshian-tailscale-{stamp}.err"));
    let stdout_file = std::fs::File::create(&stdout_path).map_err(|error| error.to_string())?;
    let stderr_file = std::fs::File::create(&stderr_path).map_err(|error| error.to_string())?;
    let mut child = std::process::Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|error| error.to_string())?;
    let start = Instant::now();

    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let stdout = read_and_remove(&stdout_path);
            let stderr = read_and_remove(&stderr_path);
            return Ok(CommandResult {
                status,
                stdout,
                stderr,
                timed_out: false,
            });
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let stdout = read_and_remove(&stdout_path);
            let stderr = read_and_remove(&stderr_path);
            return Ok(CommandResult {
                status: timeout_exit_status(),
                stdout,
                stderr,
                timed_out: true,
            });
        }

        std::thread::sleep(Duration::from_millis(100));
    }
}

fn read_and_remove(path: &std::path::Path) -> String {
    let value = std::fs::read_to_string(path).unwrap_or_default();
    let _ = std::fs::remove_file(path);
    value
}

fn find_tailscale_binary() -> Option<String> {
    [
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ]
    .iter()
    .find(|path| std::path::Path::new(path).is_file())
    .map(|path| path.to_string())
}

fn tailscale_ip4(binary: &str) -> Option<String> {
    let output = std::process::Command::new(binary)
        .args(["ip", "-4"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn tailscale_serve_url(binary: &str) -> Option<String> {
    let output = std::process::Command::new(binary)
        .args(["serve", "status", "--json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let status_json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let web = status_json.get("Web")?.as_object()?;
    let host = web.keys().next()?;
    if host.starts_with("http://") || host.starts_with("https://") {
        Some(host.to_string())
    } else {
        Some(format!("https://{host}"))
    }
}

fn preferred_private_url(dns_name: Option<&str>, ip4: Option<&str>) -> Option<String> {
    if let Some(name) = dns_name {
        if !name.is_empty() {
            return Some(format!("https://{name}"));
        }
    }
    ip4.map(|ip| format!("http://{ip}:{LOCAL_SHARE_PORT}"))
}

fn ensure_local_app_server() {
    let _ = LOCAL_SHARE_SERVER.get_or_init(|| {
        std::thread::spawn(|| {
            if let Err(error) = run_local_share_server() {
                eprintln!("local share server failed: {error}");
            }
        });
        Ok(())
    });
}

fn run_local_share_server() -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", LOCAL_SHARE_PORT))
        .map_err(|error| format!("Unable to start local share server: {error}"))?;

    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                std::thread::spawn(move || {
                    let _ = handle_local_request(&mut stream);
                });
            }
            Err(error) => eprintln!("local share connection failed: {error}"),
        }
    }
    Ok(())
}

fn handle_local_request(stream: &mut std::net::TcpStream) -> Result<(), String> {
    let request_bytes = read_http_request(stream)?;
    let header_end = request_bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .unwrap_or(request_bytes.len());
    let headers = String::from_utf8_lossy(&request_bytes[..header_end]);
    let body_bytes = &request_bytes[header_end..];
    let first_line = headers.lines().next().unwrap_or("GET / HTTP/1.1");
    let mut first_line_parts = first_line.split_whitespace();
    let method = first_line_parts.next().unwrap_or("GET");
    let path = first_line_parts.next().unwrap_or("/");

    if path == "/api/provider-key-statuses" {
        let statuses = provider_key_statuses()?;
        let body = serde_json::to_vec(&statuses).map_err(|error| error.to_string())?;
        return write_local_response(stream, "200 OK", "application/json; charset=utf-8", &body);
    }

    if method == "POST" && path == "/api/provider-request" {
        let request: ProviderRequest = match serde_json::from_slice(body_bytes) {
            Ok(request) => request,
            Err(error) => {
                return write_error_response(stream, "400 Bad Request", &error.to_string());
            }
        };
        let runtime = match tokio::runtime::Runtime::new() {
            Ok(runtime) => runtime,
            Err(error) => {
                return write_error_response(stream, "500 Internal Server Error", &error.to_string());
            }
        };
        let response = match runtime.block_on(perform_provider_request(request)) {
            Ok(response) => response,
            Err(error) => return write_error_response(stream, "400 Bad Request", &error),
        };
        return write_local_response(
            stream,
            &format!("{} {}", response.status, response.status_text),
            "application/json; charset=utf-8",
            response.body.as_bytes(),
        );
    }

    let (status, content_type, body) = local_asset(path);
    write_local_response(stream, status, content_type, body)
}

fn write_error_response(
    stream: &mut std::net::TcpStream,
    status: &str,
    message: &str,
) -> Result<(), String> {
    let body = serde_json::json!({
        "error": {
            "message": message
        }
    });
    write_local_response(
        stream,
        status,
        "application/json; charset=utf-8",
        body.to_string().as_bytes(),
    )
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Result<Vec<u8>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;

    let mut request = Vec::new();
    let mut buffer = [0_u8; 8192];
    let max_size = 2 * 1024 * 1024;

    loop {
        let read_count = stream.read(&mut buffer).map_err(|error| error.to_string())?;
        if read_count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read_count]);
        if request.len() > max_size {
            return Err("Request is too large for the local relay.".to_string());
        }

        if let Some(header_end) = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|position| position + 4)
        {
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if request.len() >= header_end + content_length {
                break;
            }
        }
    }

    Ok(request)
}

fn write_local_response(
    stream: &mut std::net::TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| error.to_string())
}

fn local_asset(path: &str) -> (&'static str, &'static str, &'static [u8]) {
    match path.split('?').next().unwrap_or("/") {
        "/" | "/index.html" => (
            "200 OK",
            "text/html; charset=utf-8",
            include_bytes!("../../app-dist/index.html"),
        ),
        "/src/app.js" => (
            "200 OK",
            "text/javascript; charset=utf-8",
            include_bytes!("../../app-dist/src/app.js"),
        ),
        "/src/styles.css" => (
            "200 OK",
            "text/css; charset=utf-8",
            include_bytes!("../../app-dist/src/styles.css"),
        ),
        "/src/models.json" => (
            "200 OK",
            "application/json; charset=utf-8",
            include_bytes!("../../app-dist/src/models.json"),
        ),
        "/src/vendor/qrcode.js" => (
            "200 OK",
            "text/javascript; charset=utf-8",
            include_bytes!("../../app-dist/src/vendor/qrcode.js"),
        ),
        _ => (
            "404 Not Found",
            "text/plain; charset=utf-8",
            b"Not found",
        ),
    }
}
