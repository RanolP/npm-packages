mod actor;
mod describe;
mod host;
mod http;
mod isolate;

use crate::host::Host;
use std::collections::HashMap;
use std::env;
use std::error::Error;
use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;

pub(crate) type AnyError = Box<dyn Error + Send + Sync>;

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
    let host = Arc::new(Host {
        apps,
        describe_workers: Mutex::new(HashMap::new()),
        workers: Mutex::new(HashMap::new()),
    });
    http::serve(address, host).await
}
