package dev.octri.parser;

import com.fasterxml.jackson.databind.JsonNode;

/** Rust diagnostics retain code, severity, physical source and related locations. */
public final class ParserError extends RuntimeException {
  private final JsonNode diagnostics;

  public ParserError(JsonNode error) {
    super(error.path("message").asText());
    diagnostics = error.path("diagnostics").deepCopy();
  }

  public JsonNode diagnostics() {
    return diagnostics.deepCopy();
  }
}
