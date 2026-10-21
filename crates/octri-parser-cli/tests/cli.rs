#![allow(clippy::unwrap_used, clippy::panic)]
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn invoke(args: &[&str], input: &str) -> std::process::Output {
    let mut process = Command::new(env!("CARGO_BIN_EXE_octri-openapi"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    process.wait_with_output().unwrap()
}
#[test]
fn validates_stdin_and_reports_machine_readable_errors() {
    let valid =
        json!({"openapi":"3.1.2","info":{"title":"Pets","version":"1"},"paths":{}}).to_string();
    let output = invoke(&["validate"], &valid);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["openapi"],
        "3.1.2"
    );
    let output = invoke(&["analyze"], "openapi: 3.1.2\npaths: {}\n");
    assert!(!output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["valid"],
        false
    );
    let output = invoke(&["bundle"], "not an OpenAPI document");
    assert!(!output.status.success());
    assert!(serde_json::from_slice::<Value>(&output.stderr).unwrap()["diagnostics"].is_array());
}
#[test]
fn cyclic_exports_require_an_explicit_policy() {
    let document = json!({"openapi":"3.1.2","info":{"title":"Pets","version":"1"},"paths":{},"components":{"schemas":{"Tree":{"type":"object","properties":{"child":{"$ref":"#/components/schemas/Tree"}}}}}}).to_string();
    let output = invoke(&["dereference"], &document);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("CIRCULAR_SERIALIZATION"));
    let output = invoke(&["dereference", "--circular", "ignore"], &document);
    assert!(output.status.success());
    assert!(serde_json::from_slice::<Value>(&output.stdout).unwrap()["components"]["schemas"]["Tree"]["properties"]["child"].get("$ref").is_some());
}
#[test]
fn output_is_not_clobbered_without_force() {
    let directory = std::env::temp_dir().join(format!("octri-cli-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("result.json");
    std::fs::write(&path, "keep").unwrap();
    let document =
        json!({"openapi":"3.1.2","info":{"title":"Pets","version":"1"},"paths":{}}).to_string();
    let output = invoke(&["parse", "--output", path.to_str().unwrap()], &document);
    assert!(!output.status.success());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep");
    let output = invoke(
        &["parse", "--output", path.to_str().unwrap(), "--force"],
        &document,
    );
    assert!(output.status.success());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn compatible_defaults_and_strict_flag_have_distinct_acceptance() {
    let input = r#"{"openapi":"3.1.2","info":{"title":"Pets"},"paths":{}}"#;
    let output = invoke(&["validate"], input);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["info"]["version"],
        "0.1.0"
    );
    let strict = invoke(&["validate", "--strict"], input);
    assert!(!strict.status.success());
    assert!(String::from_utf8_lossy(&strict.stderr).contains("OPENAPI_SCHEMA"));
}
