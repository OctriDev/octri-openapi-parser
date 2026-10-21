package dev.octri.parser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Plain-JVM consumer check; no external test framework required. */
public final class BindingCheck {
  public static void main(String[] args) throws Exception {
    Parser parser = new Parser(Path.of(args[0]), Path.of(args[1]));
    ObjectMapper json = new ObjectMapper();
    Source source = Source.text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n");
    for (String operation :
        new String[] {
          "parse", "resolve", "bundle", "dereference", "validate", "inspect", "analyze"
        }) {
      if (!parser.execute(operation, source, null).path("valid").asBoolean())
        throw new AssertionError(operation);
    }
    if (!parser
        .document("parse", source, null)
        .path("document")
        .path("info")
        .path("title")
        .asText()
        .equals("雪")) throw new AssertionError("document");
    if (!parser
        .serialize(parser.parse(source, null).path("document"), "yaml", null)
        .contains("openapi:")) throw new AssertionError("writer");
    try {
      parser.validate(Source.text("{}"), null);
      throw new AssertionError("Invalid input accepted");
    } catch (ParserError error) {
      if (error.diagnostics().isEmpty()) throw new AssertionError("diagnostics");
    }
    var pool = Executors.newFixedThreadPool(8);
    try {
      var futures = new ArrayList<Future<JsonNode>>();
      for (int index = 0; index < 32; index++)
        futures.add(pool.submit(() -> parser.validate(source, null)));
      for (var future : futures)
        if (!future.get().path("valid").asBoolean()) throw new AssertionError("concurrency");
    } finally {
      pool.shutdown();
    }
    try (var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      for (String line; (line = input.readLine()) != null; ) {
        JsonNode envelope = json.readTree(line);
        JsonNode response = parser.call(envelope);
        if (envelope.path("action").asText().equals("report") && response.has("Ok")) {
          JsonNode request = envelope.path("request");
          JsonNode inputSource = request.path("input");
          Source reportSource =
              new Source(
                  inputSource.path("uri").asText(),
                  inputSource.path("content").isTextual()
                      ? inputSource.path("content").asText()
                      : null,
                  inputSource.path("generated").asBoolean());
          JsonNode actual =
              parser.execute(
                  request.path("operation").asText(), reportSource, request.get("options"));
          if (!actual.equals(response.get("Ok")))
            throw new AssertionError("compact facade differs from native report");
        }
        System.out.write(response.toString().getBytes(StandardCharsets.UTF_8));
        System.out.write(10);
      }
    }
  }
}
