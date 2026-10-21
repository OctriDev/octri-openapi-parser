use octri_parser_sdk::{Parser, text};
use std::io::{self, BufRead};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let parser = Parser::default();
    let source = text(
        "openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n",
        "memory://octri/openapi.yaml",
    );
    assert!(parser.validate(source)?.valid);
    for line in io::stdin().lock().lines() {
        let line = line?;
        println!("{}", octri_parser_ffi::dispatch(line.as_bytes()));
    }
    Ok(())
}
