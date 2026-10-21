//! Node-API owns scheduling and strings; parser behavior stays in octri-parser.
use napi::{Task, bindgen_prelude::*};
use napi_derive::napi;

pub struct ParserTask {
    input: TaskInput,
}
enum TaskInput {
    Parse(String),
    Document(String),
    Serialize {
        document: String,
        format: String,
        limits: String,
    },
}

impl Task for ParserTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> napi::Result<String> {
        Ok(match &self.input {
            TaskInput::Parse(request) => octri_parser::wire::encode_report(
                octri_parser::wire::request(request).and_then(octri_parser_native::execute),
            ),
            TaskInput::Document(request) => octri_parser::wire::encode_document(
                octri_parser::wire::request(request)
                    .and_then(octri_parser_native::execute_document),
            ),
            TaskInput::Serialize {
                document,
                format,
                limits,
            } => octri_parser::wire::serialize_document(document, format, limits),
        })
    }
    fn resolve(&mut self, _: Env, output: String) -> napi::Result<String> {
        Ok(output)
    }
}

#[napi]
pub fn execute(request: String) -> AsyncTask<ParserTask> {
    AsyncTask::new(ParserTask {
        input: TaskInput::Parse(request),
    })
}

#[napi(js_name = "executeDocument")]
pub fn execute_document(request: String) -> AsyncTask<ParserTask> {
    AsyncTask::new(ParserTask {
        input: TaskInput::Document(request),
    })
}

#[napi(js_name = "serializeDocument")]
pub fn serialize_document(
    document: String,
    format: String,
    limits: String,
) -> AsyncTask<ParserTask> {
    AsyncTask::new(ParserTask {
        input: TaskInput::Serialize {
            document,
            format,
            limits,
        },
    })
}
