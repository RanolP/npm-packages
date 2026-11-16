use crate::actor::ActorWorker;
use crate::describe::DescribeWorker;
use axum::Json;
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::collections::HashMap;
use tokio::sync::Mutex;

type WorkerResult<T> = Result<T, String>;
pub(crate) type JsonResponse = (StatusCode, Json<Value>);

pub(crate) struct Host {
    pub(crate) apps: HashMap<String, String>,
    pub(crate) describe_workers: Mutex<HashMap<String, DescribeWorker>>,
    pub(crate) workers: Mutex<HashMap<(String, String, String), ActorWorker>>,
}

impl Host {
    async fn describe_worker_for(
        &self,
        app_id: &str,
        bundle: &str,
    ) -> WorkerResult<DescribeWorker> {
        let mut workers = self.describe_workers.lock().await;
        if let Some(worker) = workers.get(app_id) {
            return Ok(worker.clone());
        }
        let worker = DescribeWorker::spawn(app_id.to_owned(), bundle.to_owned())
            .map_err(|error| error.to_string())?;
        workers.insert(app_id.to_owned(), worker.clone());
        Ok(worker)
    }

    async fn worker_for(
        &self,
        app_id: &str,
        actor_type: &str,
        actor_id: &str,
        bundle: &str,
    ) -> WorkerResult<ActorWorker> {
        let key = (
            app_id.to_owned(),
            actor_type.to_owned(),
            actor_id.to_owned(),
        );
        let mut workers = self.workers.lock().await;
        if let Some(worker) = workers.get(&key) {
            return Ok(worker.clone());
        }
        let worker = ActorWorker::spawn(
            bundle.to_owned(),
            actor_type.to_owned(),
            actor_id.to_owned(),
        )
        .map_err(|error| error.to_string())?;
        workers.insert(key, worker.clone());
        Ok(worker)
    }

    pub(crate) async fn route(
        &self,
        app_id: &str,
        actor_type: &str,
        actor_id: &str,
        action: &str,
        body: &[u8],
    ) -> JsonResponse {
        let Some(bundle) = self.apps.get(app_id) else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "unknown app", "appId": app_id })),
            );
        };

        let args: Value = match serde_json::from_slice(body) {
            Ok(Value::Array(args)) => Value::Array(args),
            Ok(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "request body must be a JSON array" })),
                );
            }
            Err(error) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "invalid JSON", "message": error.to_string() })),
                );
            }
        };

        let describe_worker = match self.describe_worker_for(app_id, bundle).await {
            Ok(worker) => worker,
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "describe worker creation failed", "message": error })),
                );
            }
        };

        match describe_worker.describe(actor_type, action).await {
            Ok(Some(segment)) if segment == "actorType" => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "unknown actor type", "actorType": actor_type })),
                );
            }
            Ok(Some(segment)) if segment == "action" => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(json!({ "error": "unknown action", "action": action })),
                );
            }
            Ok(Some(segment)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "unknown failed segment", "segment": segment })),
                );
            }
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        json!({ "error": "bundle inspection failed", "message": error.to_string() }),
                    ),
                );
            }
            Ok(None) => {}
        }

        let worker = match self.worker_for(app_id, actor_type, actor_id, bundle).await {
            Ok(worker) => worker,
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "actor worker creation failed", "message": error })),
                );
            }
        };

        match worker.invoke(action, args).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "actor action failed", "message": error })),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn invalid_routes_do_not_create_actor_workers() {
        let bundle = r#"
            globalThis.__katsudouDescribe = (actorType, action) => {
                if (actorType !== "Counter") return "actorType";
                if (action !== "go") return "action";
            };
        "#;
        let host = Host {
            apps: HashMap::from([("demo".to_owned(), bundle.to_owned())]),
            describe_workers: Mutex::new(HashMap::new()),
            workers: Mutex::new(HashMap::new()),
        };

        for index in 0..20 {
            let actor_id = format!("x{index}");
            let response = host.route("demo", "Missing", &actor_id, "go", b"[]").await;
            assert_eq!(response.0, StatusCode::NOT_FOUND);

            let response = host
                .route("demo", "Counter", &actor_id, "missing", b"[]")
                .await;
            assert_eq!(response.0, StatusCode::NOT_FOUND);
        }

        assert_eq!(host.workers.lock().await.len(), 0);
        assert_eq!(host.describe_workers.lock().await.len(), 1);
    }
}
