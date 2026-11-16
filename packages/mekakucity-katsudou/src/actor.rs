use crate::AnyError;
use crate::isolate::Isolate;
use serde_json::Value;
use std::thread;
use tokio::sync::{mpsc, oneshot};

type WorkerResult<T> = Result<T, String>;

pub(crate) struct ActorCommand {
    action: String,
    args: Value,
    reply: oneshot::Sender<WorkerResult<Value>>,
}

#[derive(Clone)]
pub(crate) struct ActorWorker {
    sender: mpsc::UnboundedSender<ActorCommand>,
}

impl ActorWorker {
    pub(crate) fn spawn(
        bundle: String,
        actor_type: String,
        actor_id: String,
    ) -> Result<Self, AnyError> {
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

    pub(crate) async fn invoke(&self, action: &str, args: Value) -> WorkerResult<Value> {
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

pub(crate) async fn run_actor_worker(
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
