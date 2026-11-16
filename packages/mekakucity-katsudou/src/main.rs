use deno_core::{JsRuntime, RuntimeOptions, serde_v8, v8};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::fs;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio::time::timeout;

type AnyError = Box<dyn Error + Send + Sync>;

struct Isolate {
    runtime: JsRuntime,
}

impl Isolate {
    fn load(bundle: &str) -> Result<Self, AnyError> {
        let mut runtime = JsRuntime::new(RuntimeOptions::default());
        runtime.execute_script("<app_bundle>", bundle.to_owned())?;
        Ok(Self { runtime })
    }

    fn create(&mut self, actor_type: &str, actor_id: &str) -> Result<(), AnyError> {
        let create = format!(
            "globalThis.__katsudouCreate({}, {})",
            serde_json::to_string(actor_type)?,
            serde_json::to_string(actor_id)?,
        );
        self.runtime.execute_script("<create_actor>", create)?;
        Ok(())
    }

    fn describe(&mut self, actor_type: &str, action: &str) -> Result<Option<String>, AnyError> {
        let expression = format!(
            "globalThis.__katsudouDescribe({}, {})",
            serde_json::to_string(actor_type)?,
            serde_json::to_string(action)?,
        );
        let result = eval(&mut self.runtime, expression)?;
        Ok(result.as_str().map(str::to_owned))
    }

    async fn invoke(&mut self, action: &str, args: Value) -> Result<Value, AnyError> {
        let expression = format!(
            "globalThis.__katsudouResult = undefined; Promise.resolve(globalThis.__katsudouInvoke({}, {})).then(value => {{ globalThis.__katsudouResult = {{ ok: true, value }}; }}, error => {{ globalThis.__katsudouResult = {{ ok: false, error: String(error?.message ?? error) }}; }});",
            serde_json::to_string(action)?,
            serde_json::to_string(&args)?,
        );
        self.runtime.execute_script("<invoke_actor>", expression)?;
        self.runtime.run_event_loop(Default::default()).await?;
        let envelope: Value = eval(&mut self.runtime, "globalThis.__katsudouResult".to_owned())?;
        if envelope.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(envelope.get("value").cloned().unwrap_or(Value::Null));
        }
        let message = envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Actor action failed");
        Err(message.to_owned().into())
    }
}

fn eval(runtime: &mut JsRuntime, code: String) -> Result<Value, AnyError> {
    let global = runtime.execute_script("<eval>", code)?;
    deno_core::scope!(scope, runtime);
    let local = v8::Local::new(scope, global);
    Ok(serde_v8::from_v8::<Value>(scope, local)?)
}

type WorkerResult<T> = Result<T, String>;

struct DescribeCommand {
    actor_type: String,
    action: String,
    reply: oneshot::Sender<WorkerResult<Option<String>>>,
}

#[derive(Clone)]
struct DescribeWorker {
    sender: mpsc::UnboundedSender<DescribeCommand>,
}

impl DescribeWorker {
    fn spawn(app_id: String, bundle: String) -> Result<Self, AnyError> {
        let (sender, receiver) = mpsc::unbounded_channel();
        thread::Builder::new()
            .name(format!("katsudou-describe-{app_id}"))
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("describe worker runtime error: {error}");
                        return;
                    }
                };
                runtime.block_on(run_describe_worker(bundle, receiver));
            })?;
        Ok(Self { sender })
    }

    async fn describe(&self, actor_type: &str, action: &str) -> WorkerResult<Option<String>> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(DescribeCommand {
                actor_type: actor_type.to_owned(),
                action: action.to_owned(),
                reply,
            })
            .map_err(|_| "describe worker stopped".to_owned())?;
        response
            .await
            .map_err(|_| "describe worker dropped its response".to_owned())?
    }
}

async fn run_describe_worker(
    bundle: String,
    mut receiver: mpsc::UnboundedReceiver<DescribeCommand>,
) {
    let mut isolate = Isolate::load(&bundle).map_err(|error| error.to_string());
    while let Some(command) = receiver.recv().await {
        let result = match &mut isolate {
            Ok(isolate) => isolate
                .describe(&command.actor_type, &command.action)
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.clone()),
        };
        let _ = command.reply.send(result);
    }
}

struct ActorCommand {
    action: String,
    args: Value,
    reply: oneshot::Sender<WorkerResult<Value>>,
}

#[derive(Clone)]
struct ActorWorker {
    sender: mpsc::UnboundedSender<ActorCommand>,
}

impl ActorWorker {
    fn spawn(bundle: String, actor_type: String, actor_id: String) -> Result<Self, AnyError> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let thread_name = format!("katsudou-{actor_type}-{actor_id}");
        thread::Builder::new().name(thread_name).spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("actor worker runtime error: {error}");
                    return;
                }
            };
            runtime.block_on(run_actor_worker(bundle, actor_type, actor_id, receiver));
        })?;
        Ok(Self { sender })
    }

    async fn invoke(&self, action: &str, args: Value) -> WorkerResult<Value> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(ActorCommand {
                action: action.to_owned(),
                args,
                reply,
            })
            .map_err(|_| "actor worker stopped".to_owned())?;
        response
            .await
            .map_err(|_| "actor worker dropped its response".to_owned())?
    }
}

async fn run_actor_worker(
    bundle: String,
    actor_type: String,
    actor_id: String,
    mut receiver: mpsc::UnboundedReceiver<ActorCommand>,
) {
    let mut isolate = Isolate::load(&bundle).map_err(|error| error.to_string());
    let mut created = false;
    while let Some(command) = receiver.recv().await {
        let result = match &mut isolate {
            Ok(isolate) => {
                if !created {
                    match isolate.create(&actor_type, &actor_id) {
                        Ok(()) => created = true,
                        Err(error) => {
                            let _ = command.reply.send(Err(error.to_string()));
                            continue;
                        }
                    }
                }
                isolate
                    .invoke(&command.action, command.args)
                    .await
                    .map_err(|error| error.to_string())
            }
            Err(error) => Err(error.clone()),
        };
        let _ = command.reply.send(result);
    }
}

struct Host {
    apps: HashMap<String, String>,
    describe_workers: Mutex<HashMap<String, DescribeWorker>>,
    workers: Mutex<HashMap<(String, String, String), ActorWorker>>,
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

    async fn route(&self, method: &str, path: &str, body: &[u8]) -> Response {
        // The URL-to-actor/action mapping is undecided; this route shape is temporary.
        let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        if method != "POST"
            || segments.len() != 6
            || segments[0] != "apps"
            || segments[2] != "_actors"
        {
            return Response::not_found(json!({ "error": "unknown route", "path": path }));
        }

        let app_id = segments[1];
        let actor_type = segments[3];
        let actor_id = segments[4];
        let action = segments[5];
        let Some(bundle) = self.apps.get(app_id) else {
            return Response::not_found(json!({ "error": "unknown app", "appId": app_id }));
        };

        let args: Value = match serde_json::from_slice(body) {
            Ok(Value::Array(args)) => Value::Array(args),
            Ok(_) => {
                return Response::bad_request(
                    json!({ "error": "request body must be a JSON array" }),
                );
            }
            Err(error) => {
                return Response::bad_request(
                    json!({ "error": "invalid JSON", "message": error.to_string() }),
                );
            }
        };

        let describe_worker = match self.describe_worker_for(app_id, bundle).await {
            Ok(worker) => worker,
            Err(error) => {
                return Response::internal(
                    json!({ "error": "describe worker creation failed", "message": error }),
                );
            }
        };

        match describe_worker.describe(actor_type, action).await {
            Ok(Some(segment)) if segment == "actorType" => {
                return Response::not_found(
                    json!({ "error": "unknown actor type", "actorType": actor_type }),
                );
            }
            Ok(Some(segment)) if segment == "action" => {
                return Response::not_found(json!({ "error": "unknown action", "action": action }));
            }
            Ok(Some(segment)) => {
                return Response::internal(
                    json!({ "error": "unknown failed segment", "segment": segment }),
                );
            }
            Err(error) => {
                return Response::internal(
                    json!({ "error": "bundle inspection failed", "message": error.to_string() }),
                );
            }
            Ok(None) => {}
        }

        let worker = match self.worker_for(app_id, actor_type, actor_id, bundle).await {
            Ok(worker) => worker,
            Err(error) => {
                return Response::internal(
                    json!({ "error": "actor worker creation failed", "message": error }),
                );
            }
        };

        match worker.invoke(action, args).await {
            Ok(value) => Response::ok(value),
            Err(error) => {
                Response::internal(json!({ "error": "actor action failed", "message": error }))
            }
        }
    }
}

struct Response {
    status: &'static str,
    body: Value,
}

impl Response {
    fn ok(body: Value) -> Self {
        Self {
            status: "200 OK",
            body,
        }
    }

    fn bad_request(body: Value) -> Self {
        Self {
            status: "400 Bad Request",
            body,
        }
    }

    fn not_found(body: Value) -> Self {
        Self {
            status: "404 Not Found",
            body,
        }
    }

    fn internal(body: Value) -> Self {
        Self {
            status: "500 Internal Server Error",
            body,
        }
    }
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

async fn read_request(stream: &mut TcpStream) -> Result<Request, AnyError> {
    let mut bytes = Vec::new();
    let header_end = loop {
        let read = stream.read_buf(&mut bytes).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before HTTP headers",
            )
            .into());
        }
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
        if bytes.len() > 64 * 1024 {
            return Err(
                io::Error::new(io::ErrorKind::InvalidData, "HTTP headers exceed 64 KiB").into(),
            );
        }
    };
    let headers = std::str::from_utf8(&bytes[..header_end])?;
    let mut lines = headers.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?
        .to_owned();
    let path = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing path"))?
        .to_owned();
    let content_length = lines
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        })
        .map(|(_, value)| value.trim().parse::<usize>())
        .transpose()?
        .unwrap_or(0);
    if content_length > 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "HTTP body exceeds 1 MiB").into());
    }
    while bytes.len() < header_end + content_length {
        if stream.read_buf(&mut bytes).await? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "connection closed before HTTP body",
            )
            .into());
        }
    }
    Ok(Request {
        method,
        path,
        body: bytes[header_end..header_end + content_length].to_vec(),
    })
}

async fn write_response(stream: &mut TcpStream, response: Response) -> Result<(), AnyError> {
    let body = serde_json::to_vec(&response.body)?;
    let headers = format!(
        "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.status,
        body.len(),
    );
    stream.write_all(headers.as_bytes()).await?;
    stream.write_all(&body).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn serve_connection(mut stream: TcpStream, peer: SocketAddr, host: Arc<Host>) {
    // Bound idle clients so an unfinished header cannot retain a connection task forever.
    let response = match timeout(Duration::from_secs(10), read_request(&mut stream)).await {
        Ok(Ok(request)) => {
            host.route(&request.method, &request.path, &request.body)
                .await
        }
        Ok(Err(error)) => {
            eprintln!("connection {peer} read error: {error}");
            Response::bad_request(
                json!({ "error": "invalid HTTP request", "message": error.to_string() }),
            )
        }
        Err(_) => {
            eprintln!("connection {peer} read timeout");
            Response::bad_request(json!({ "error": "request timeout" }))
        }
    };
    if let Err(error) = write_response(&mut stream, response).await {
        eprintln!("connection {peer} write error: {error}");
    }
}

fn arguments() -> Result<(SocketAddr, HashMap<String, String>), AnyError> {
    let mut listen = "127.0.0.1:8787".parse()?;
    let mut apps = HashMap::new();
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--listen" => {
                let value = args.next().ok_or("--listen requires an address")?;
                listen = value.parse()?;
            }
            "--app" => {
                let value = args.next().ok_or("--app requires APP_ID=BUNDLE_PATH")?;
                let (app_id, bundle_path) = value
                    .split_once('=')
                    .ok_or("--app requires APP_ID=BUNDLE_PATH")?;
                apps.insert(app_id.to_owned(), fs::read_to_string(bundle_path)?);
            }
            _ => return Err(format!("unknown argument {argument}").into()),
        }
    }
    if apps.is_empty() {
        return Err("at least one --app APP_ID=BUNDLE_PATH is required".into());
    }
    Ok((listen, apps))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), AnyError> {
    let (address, apps) = arguments()?;
    let listener = TcpListener::bind(address).await?;
    println!("katsudou listening on {}", listener.local_addr()?);
    let host = Arc::new(Host {
        apps,
        describe_workers: Mutex::new(HashMap::new()),
        workers: Mutex::new(HashMap::new()),
    });
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let host = Arc::clone(&host);
                tokio::spawn(async move {
                    serve_connection(stream, peer, host).await;
                });
            }
            Err(error) => eprintln!("accept error: {error}"),
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
            let unknown_type = format!("/apps/demo/_actors/Missing/x{index}/go");
            let response = host.route("POST", &unknown_type, b"[]").await;
            assert_eq!(response.status, "404 Not Found");

            let unknown_action = format!("/apps/demo/_actors/Counter/x{index}/missing");
            let response = host.route("POST", &unknown_action, b"[]").await;
            assert_eq!(response.status, "404 Not Found");
        }

        assert_eq!(host.workers.lock().await.len(), 0);
        assert_eq!(host.describe_workers.lock().await.len(), 1);
    }
}
