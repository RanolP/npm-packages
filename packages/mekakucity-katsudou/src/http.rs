use crate::AnyError;
use crate::host::{Host, JsonResponse};
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::routing::post;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

pub(crate) async fn serve(address: SocketAddr, host: Arc<Host>) -> Result<(), AnyError> {
    let listener = TcpListener::bind(address).await?;
    println!("katsudou listening on {}", listener.local_addr()?);
    let router = Router::new()
        .route(
            "/apps/{app}/_actors/{actor_type}/{id}/{action}",
            post(invoke),
        )
        .with_state(host);

    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let service = TowerToHyperService::new(router.clone());
                tokio::spawn(async move {
                    let mut builder = Builder::new(TokioExecutor::new());
                    // Bound idle clients so unfinished headers cannot retain a task forever.
                    builder
                        .http1()
                        .half_close(true)
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(10));
                    if let Err(error) = builder
                        .serve_connection(TokioIo::new(stream), service)
                        .await
                    {
                        eprintln!("connection {peer} error: {error}");
                    }
                });
            }
            Err(error) => eprintln!("accept error: {error}"),
        }
    }
}

async fn invoke(
    State(host): State<Arc<Host>>,
    Path((app_id, actor_type, actor_id, action)): Path<(String, String, String, String)>,
    body: Bytes,
) -> JsonResponse {
    // The URL-to-actor/action mapping is undecided; this route shape is temporary.
    host.route(&app_id, &actor_type, &actor_id, &action, &body)
        .await
}
