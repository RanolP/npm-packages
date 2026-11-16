use crate::AnyError;
use crate::isolate::Isolate;
use std::thread;
use tokio::sync::{mpsc, oneshot};

type WorkerResult<T> = Result<T, String>;

pub(crate) struct DescribeCommand {
    actor_type: String,
    action: String,
    reply: oneshot::Sender<WorkerResult<Option<String>>>,
}

#[derive(Clone)]
pub(crate) struct DescribeWorker {
    sender: mpsc::UnboundedSender<DescribeCommand>,
}

impl DescribeWorker {
    pub(crate) fn spawn(app_id: String, bundle: String) -> Result<Self, AnyError> {
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

    pub(crate) async fn describe(
        &self,
        actor_type: &str,
        action: &str,
    ) -> WorkerResult<Option<String>> {
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

pub(crate) async fn run_describe_worker(
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
