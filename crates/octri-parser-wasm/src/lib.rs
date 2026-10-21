//! Browser transport deliberately has no file or HTTP resolver.
use octri_parser::NoIo;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn execute(request: &str) -> String {
    octri_parser::wire::encode_report(
        octri_parser::wire::request(request)
            .and_then(|request| octri_parser::execute(request, &mut NoIo)),
    )
}

#[wasm_bindgen]
pub fn execute_document(request: &str) -> String {
    octri_parser::wire::encode_document(
        octri_parser::wire::request(request)
            .and_then(|request| octri_parser::execute_document(request, &mut NoIo)),
    )
}

#[wasm_bindgen]
pub fn serialize_document(document: &str, format: &str, limits: &str) -> String {
    octri_parser::wire::serialize_document(document, format, limits)
}
