use crate::AnyError;
use deno_core::{JsRuntime, RuntimeOptions, serde_v8, v8};
use serde_json::Value;

pub(crate) struct Isolate {
    runtime: JsRuntime,
}

impl Isolate {
    pub(crate) fn load(bundle: &str) -> Result<Self, AnyError> {
        let mut runtime = JsRuntime::new(RuntimeOptions::default());
        runtime.execute_script("<app_bundle>", bundle.to_owned())?;
        Ok(Self { runtime })
    }

    pub(crate) fn create(&mut self, actor_type: &str, actor_id: &str) -> Result<(), AnyError> {
        let create = format!(
            "globalThis.__katsudouCreate({}, {})",
            serde_json::to_string(actor_type)?,
            serde_json::to_string(actor_id)?,
        );
        self.runtime.execute_script("<create_actor>", create)?;
        Ok(())
    }

    pub(crate) fn describe(
        &mut self,
        actor_type: &str,
        action: &str,
    ) -> Result<Option<String>, AnyError> {
        let expression = format!(
            "globalThis.__katsudouDescribe({}, {})",
            serde_json::to_string(actor_type)?,
            serde_json::to_string(action)?,
        );
        let result = eval(&mut self.runtime, expression)?;
        Ok(result.as_str().map(str::to_owned))
    }

    pub(crate) async fn invoke(&mut self, action: &str, args: Value) -> Result<Value, AnyError> {
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

pub(crate) fn eval(runtime: &mut JsRuntime, code: String) -> Result<Value, AnyError> {
    let global = runtime.execute_script("<eval>", code)?;
    deno_core::scope!(scope, runtime);
    let local = v8::Local::new(scope, global);
    Ok(serde_v8::from_v8::<Value>(scope, local)?)
}
