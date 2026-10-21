use clap::{Parser, ValueEnum};
use octri_parser::{Address, CircularPolicy, Input, Operation, Options, ParserError, Request};
use std::{
    fs::OpenOptions,
    io::{self, Read, Write},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Debug, Parser)]
#[command(
    name = "octri-openapi",
    version,
    about = "Parse, validate and transform OpenAPI documents"
)]
struct Args {
    #[arg(value_enum)]
    command: Command,
    /// File path, URL, or - for stdin. HTTP requires --allow-http.
    #[arg(default_value = "-")]
    input: String,
    /// Retrieval URI for stdin. This never grants filesystem access.
    #[arg(long, default_value = "memory://octri/openapi.yaml")]
    base_uri: String,
    #[arg(short, long)]
    output: Option<PathBuf>,
    #[arg(long, value_enum, default_value = "json")]
    format: Format,
    /// Overwrite an existing output file.
    #[arg(long)]
    force: bool,
    /// Emit the full result, including sources, references and diagnostics.
    #[arg(long)]
    report: bool,
    #[arg(long)]
    allow_http: bool,
    #[arg(long)]
    allow_host: Vec<String>,
    #[arg(long)]
    allow_private: bool,
    #[arg(long)]
    file_root: Option<String>,
    #[arg(long, value_enum, default_value = "preserve")]
    circular: Circular,
    #[arg(long, default_value_t = 16 * 1024 * 1024)]
    max_document_bytes: usize,
    #[arg(long, default_value_t = 64 * 1024 * 1024)]
    max_total_bytes: usize,
    #[arg(long, default_value_t = 128)]
    max_documents: usize,
    #[arg(long, default_value_t = 1_000_000)]
    max_nodes: usize,
    #[arg(long, default_value_t = 128)]
    max_depth: usize,
    #[arg(long, default_value_t = 64)]
    max_aliases: usize,
    #[arg(long, default_value_t = 64 * 1024 * 1024)]
    max_output_bytes: usize,
    #[arg(long, default_value_t = 1000)]
    max_diagnostics: usize,
    #[arg(long, default_value_t = 15_000)]
    timeout_ms: u64,
    #[arg(long, default_value_t = 5)]
    max_redirects: usize,
    #[arg(long)]
    no_external: bool,
    #[arg(long)]
    no_schema_validation: bool,
    /// Enable strict reference-target, JSON Schema and audit semantic checks.
    #[arg(long)]
    strict: bool,
    #[arg(long)]
    no_spec_validation: bool,
}
#[derive(Debug, Clone, Copy, ValueEnum)]
enum Command {
    Parse,
    Resolve,
    Bundle,
    Dereference,
    Validate,
    Inspect,
    Analyze,
}
#[derive(Debug, Clone, Copy, ValueEnum)]
enum Circular {
    Preserve,
    Ignore,
    Error,
}
#[derive(Debug, Clone, Copy, ValueEnum)]
enum Format {
    Json,
    Yaml,
}

fn main() -> ExitCode {
    let args = Args::parse();
    match run(&args) {
        Ok(valid) => {
            if valid {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Err(error) => {
            let _ = serde_json::to_writer(io::stderr().lock(), &error);
            eprintln!();
            ExitCode::from(1)
        }
    }
}
fn run(args: &Args) -> Result<bool, ParserError> {
    let mut options = Options::default();
    options.resolve.http = args.allow_http;
    options.resolve.allow_hosts = args.allow_host.clone();
    options.resolve.allow_private = args.allow_private;
    options.resolve.file_root = args.file_root.clone();
    options.limits = octri_parser::Limits {
        max_document_bytes: args.max_document_bytes,
        max_total_bytes: args.max_total_bytes,
        max_documents: args.max_documents,
        max_nodes: args.max_nodes,
        max_depth: args.max_depth,
        max_aliases: args.max_aliases,
        max_output_bytes: args.max_output_bytes,
        max_diagnostics: args.max_diagnostics,
    };
    options.resolve.timeout_ms = args.timeout_ms;
    options.resolve.max_redirects = args.max_redirects;
    options.resolve.external = !args.no_external;
    options.validate.mode = if args.strict {
        octri_parser::ValidationMode::Strict
    } else {
        octri_parser::ValidationMode::Compatible
    };
    options.validate.schema = !args.no_schema_validation;
    options.validate.spec = !args.no_spec_validation;
    options.dereference.circular = match args.circular {
        Circular::Preserve => CircularPolicy::Preserve,
        Circular::Ignore => CircularPolicy::Ignore,
        Circular::Error => CircularPolicy::Error,
    };
    let operation = match args.command {
        Command::Parse => Operation::Parse,
        Command::Resolve => Operation::Resolve,
        Command::Bundle => Operation::Bundle,
        Command::Dereference => Operation::Dereference,
        Command::Validate => Operation::Validate,
        Command::Inspect => Operation::Inspect,
        Command::Analyze => Operation::Analyze,
    };
    let input = if args.input == "-" {
        let mut bytes = Vec::new();
        io::stdin()
            .take(options.limits.max_document_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > options.limits.max_document_bytes {
            return Err(ParserError::new(
                "LIMIT_DOCUMENT_BYTES",
                "stdin exceeds byte limit",
                Address::default(),
            ));
        }
        Input {
            uri: args.base_uri.clone(),
            content: Some(String::from_utf8(bytes).map_err(|e| io_error(io::Error::other(e)))?),
            generated: false,
        }
    } else {
        Input {
            uri: args.input.clone(),
            content: None,
            generated: false,
        }
    };
    let result = octri_parser_native::execute(Request {
        operation,
        input,
        options: options.clone(),
    })?;
    let value = if args.report {
        serde_json::to_value(&result).map_err(|e| io_error(io::Error::other(e)))?
    } else if matches!(operation, Operation::Analyze | Operation::Resolve) {
        serde_json::json!({
            "valid": result.valid,
            "dialect": result.dialect,
            "diagnostics": result.diagnostics,
            "sources": result.sources.iter().map(|source| serde_json::json!({"uri": source.uri, "bytes": source.bytes})).collect::<Vec<_>>(),
            "references": result.references,
            "statistics": result.inspection.as_ref().map(|inspection| &inspection.statistics),
        })
    } else if operation == Operation::Inspect {
        serde_json::to_value(&result.inspection).map_err(|e| io_error(io::Error::other(e)))?
    } else {
        result.document.ok_or_else(|| {
            ParserError::new(
                "CIRCULAR_SERIALIZATION",
                "Circular graph cannot be exported; use --circular ignore or --report",
                Address::default(),
            )
        })?
    };
    let text = match args.format {
        Format::Json => octri_parser::serialize(&value, &options.limits)?,
        Format::Yaml => octri_parser::serialize_yaml(&value, &options.limits)?,
    };
    let mut output: Box<dyn Write> = match args.output.as_ref() {
        Some(path) => Box::new(
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(args.force)
                .create_new(!args.force)
                .open(path)
                .map_err(io_error)?,
        ),
        None => Box::new(io::stdout().lock()),
    };
    writeln!(output, "{text}").map_err(io_error)?;
    Ok(result.valid)
}
fn io_error(error: io::Error) -> ParserError {
    ParserError::new("CLI_IO", error.to_string(), Address::default())
}
