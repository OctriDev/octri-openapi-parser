//! Stateless native Rust facade. Use octri-parser directly for a custom Resolver
//! or environments without host I/O. No FFI or JSON bridge is needed in Rust.
pub use octri_parser::{self as core, *};
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct Parser {
    pub options: Options,
}

impl Parser {
    pub fn new(options: Options) -> Self {
        Self { options }
    }

    pub fn execute(&self, operation: Operation, input: Input) -> Result<Report> {
        octri_parser_native::execute(Request {
            operation,
            input,
            options: self.options.clone(),
        })
    }

    pub fn document(&self, operation: Operation, input: Input) -> Result<DocumentOutput> {
        octri_parser_native::execute_document(Request {
            operation,
            input,
            options: self.options.clone(),
        })
    }

    pub fn parse(&self, input: Input) -> Result<Report> {
        self.execute(Operation::Parse, input)
    }
    pub fn resolve(&self, input: Input) -> Result<Report> {
        self.execute(Operation::Resolve, input)
    }
    pub fn bundle(&self, input: Input) -> Result<Report> {
        self.execute(Operation::Bundle, input)
    }
    pub fn dereference(&self, input: Input) -> Result<Report> {
        self.execute(Operation::Dereference, input)
    }
    pub fn validate(&self, input: Input) -> Result<Report> {
        self.execute(Operation::Validate, input)
    }
    pub fn inspect(&self, input: Input) -> Result<Report> {
        self.execute(Operation::Inspect, input)
    }
    pub fn analyze(&self, input: Input) -> Result<Report> {
        self.execute(Operation::Analyze, input)
    }
}

pub fn text(content: impl Into<String>, uri: impl Into<String>) -> Input {
    Input {
        uri: uri.into(),
        content: Some(content.into()),
        generated: false,
    }
}

pub fn path(path: impl AsRef<Path>) -> Input {
    Input {
        uri: path.as_ref().to_string_lossy().into_owned(),
        content: None,
        generated: false,
    }
}

pub fn object(document: &serde_json::Value, uri: impl Into<String>) -> Result<Input> {
    let uri = uri.into();
    serde_json::to_string(document)
        .map(|content| Input {
            uri: uri.clone(),
            content: Some(content),
            generated: true,
        })
        .map_err(|error| {
            ParserError::new(
                "INVALID_JSON",
                error.to_string(),
                Address {
                    uri,
                    pointer: String::new(),
                },
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn facade_keeps_defaults_sources_and_structured_errors() -> Result<()> {
        let parser = Parser::default();
        let input = text(
            "openapi: 3.1.2\ninfo: {title: 雪}\npaths: {}\n",
            "memory://test/api.yaml",
        );
        let report = parser.analyze(input.clone())?;
        assert!(report.valid);
        assert_eq!(
            report
                .document
                .as_ref()
                .and_then(|doc| doc.pointer("/info/version"))
                .and_then(serde_json::Value::as_str),
            Some("0.1.0")
        );
        assert!(
            report.sources[0]
                .document
                .pointer("/info/version")
                .is_none()
        );
        let mut strict = parser.clone();
        strict.options.validate.mode = ValidationMode::Strict;
        assert!(strict.validate(input).is_err());
        Ok(())
    }
}
