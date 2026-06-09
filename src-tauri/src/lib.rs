#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![http_request])
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
