mod cloud;

use std::path::{Path as FilePath, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use cloud::{Cloud, Metadata};
use serde::{Deserialize, Serialize};
use tokio::{io::AsyncWriteExt, sync::RwLock};
use tower_http::services::ServeDir;

#[derive(Default)]
struct App {
    current: RwLock<Option<Arc<Cloud>>>,
    next_id: AtomicU64,
}

struct ApiError(StatusCode, String);

impl ApiError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    fn missing(message: &str) -> Self {
        Self(StatusCode::NOT_FOUND, message.into())
    }
    fn internal(error: impl std::fmt::Display) -> Self {
        eprintln!("{error}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The local server could not complete the request.".into(),
        )
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(ErrorBody { error: self.1 })).into_response()
    }
}

const FRONTEND_BUILD_HINT: &str = "Viewer files are missing. From the project root, run npm.cmd ci --prefix web and npm.cmd run build --prefix web, then restart the server.";

fn frontend_dir(executable: &FilePath) -> Option<PathBuf> {
    executable
        .ancestors()
        .skip(1)
        .chain(std::iter::once(FilePath::new(env!("CARGO_MANIFEST_DIR"))))
        .map(|directory| directory.join("web/dist"))
        .find(|directory| directory.join("index.html").is_file())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let app = Router::new()
        .route(
            "/api/clouds",
            post(open_cloud).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/clouds/{id}/positions", get(positions))
        .route("/api/clouds/{id}/rgb", get(rgb))
        .route("/api/clouds/{id}/fields/{field}/colors", get(colors))
        .route("/api/clouds/{id}/fields/{field}/groups", get(groups))
        .route(
            "/api/clouds/{id}/fields/{field}/points/{point}",
            get(instance),
        )
        .with_state(Arc::new(App::default()));
    let app = match frontend_dir(&std::env::current_exe()?) {
        Some(directory) => app.fallback_service(ServeDir::new(directory)),
        None => {
            eprintln!("{FRONTEND_BUILD_HINT}");
            app.route(
                "/",
                get(|| async { (StatusCode::SERVICE_UNAVAILABLE, FRONTEND_BUILD_HINT) }),
            )
        }
    };

    let port = std::env::var("POINT_CLOUD_PORT").map_or(Ok(3000), |value| value.parse::<u16>())?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!(
        "Point Cloud Tool is running at http://{}",
        listener.local_addr()?
    );
    axum::serve(listener, app).await?;
    Ok(())
}

async fn open_cloud(
    State(app): State<Arc<App>>,
    mut form: Multipart,
) -> Result<Json<Metadata>, ApiError> {
    let mut file = form
        .next_field()
        .await
        .map_err(|error| ApiError::invalid(error.body_text()))?
        .ok_or_else(|| ApiError::invalid("Choose a LAS or LAZ file."))?;
    if file.name() != Some("file") {
        return Err(ApiError::invalid("Choose a LAS or LAZ file."));
    }
    let name = file.file_name().unwrap_or_default().to_owned();
    let extension = std::path::Path::new(&name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if !extension.eq_ignore_ascii_case("las") && !extension.eq_ignore_ascii_case("laz") {
        return Err(ApiError::invalid("Choose a .las or .laz file."));
    }
    let temp = tempfile::NamedTempFile::new().map_err(ApiError::internal)?;
    let mut output = tokio::fs::File::from_std(temp.reopen().map_err(ApiError::internal)?);
    while let Some(chunk) = file
        .chunk()
        .await
        .map_err(|error| ApiError::invalid(error.body_text()))?
    {
        output.write_all(&chunk).await.map_err(ApiError::internal)?;
    }
    output.flush().await.map_err(ApiError::internal)?;
    drop(output);

    let id = app.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cloud = tokio::task::spawn_blocking(move || Cloud::read(temp.path(), id, name))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::invalid)?;
    let metadata = cloud.meta.clone();
    *app.current.write().await = Some(Arc::new(cloud));
    Ok(Json(metadata))
}

async fn active_cloud(app: &App, id: u64) -> Result<Arc<Cloud>, ApiError> {
    app.current
        .read()
        .await
        .as_ref()
        .filter(|cloud| cloud.meta.id == id)
        .cloned()
        .ok_or_else(|| ApiError::missing("This plot is no longer open."))
}

fn binary(bytes: Bytes) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response()
}

async fn positions(State(app): State<Arc<App>>, Path(id): Path<u64>) -> Result<Response, ApiError> {
    Ok(binary(active_cloud(&app, id).await?.positions.clone()))
}

async fn rgb(State(app): State<Arc<App>>, Path(id): Path<u64>) -> Result<Response, ApiError> {
    let cloud = active_cloud(&app, id).await?;
    cloud
        .rgb
        .clone()
        .map(binary)
        .ok_or_else(|| ApiError::missing("This plot has no RGB colors."))
}

#[derive(Deserialize)]
struct ColorQuery {
    categorical: bool,
}

async fn colors(
    State(app): State<Arc<App>>,
    Path((id, field)): Path<(u64, usize)>,
    Query(query): Query<ColorQuery>,
) -> Result<Response, ApiError> {
    let cloud = active_cloud(&app, id).await?;
    let colors = tokio::task::spawn_blocking(move || cloud.colors(field, query.categorical))
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::missing("Scalar field not found."))?;
    Ok(binary(colors.into()))
}

async fn groups(
    State(app): State<Arc<App>>,
    Path((id, field)): Path<(u64, usize)>,
) -> Result<Response, ApiError> {
    let cloud = active_cloud(&app, id).await?;
    let groups = tokio::task::spawn_blocking(move || cloud.group_indexes(field))
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::missing("Instance field not found."))?;
    Ok(binary(groups))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    point: usize,
    group: u32,
    label: Option<String>,
    point_count: u32,
}

async fn instance(
    State(app): State<Arc<App>>,
    Path((id, field, point)): Path<(u64, usize, usize)>,
) -> Result<Json<Selection>, ApiError> {
    let cloud = active_cloud(&app, id).await?;
    let (group, label, point_count) =
        tokio::task::spawn_blocking(move || cloud.instance(field, point))
            .await
            .map_err(ApiError::internal)?
            .ok_or_else(|| ApiError::missing("Point or instance field not found."))?;
    Ok(Json(Selection {
        point,
        group,
        label,
        point_count,
    }))
}
