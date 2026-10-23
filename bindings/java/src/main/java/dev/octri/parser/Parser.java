package dev.octri.parser;

import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Path;

/**
 * Stateless synchronous binding. Calls may run concurrently on separate threads. Reports use
 * Jackson trees: exact JSON numbers, complete source locations and explicit graph IDs. No reference
 * semantics are implemented on the JVM.
 */
public final class Parser {
  private static final int MAX_REQUEST_BYTES = 128 * 1024 * 1024;
  private static final ObjectMapper JSON =
      JsonMapper.builder()
          .enable(com.fasterxml.jackson.databind.DeserializationFeature.USE_BIG_INTEGER_FOR_INTS)
          .enable(com.fasterxml.jackson.databind.DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
          .build();

  static {
    JSON.getFactory()
        .setStreamReadConstraints(
            StreamReadConstraints.builder()
                .maxNestingDepth(512)
                .maxStringLength(128 * 1024 * 1024)
                .build());
  }

  /** Loads the native library pair packaged in this jar for the current platform. */
  public Parser() throws IOException {
    NativeBridge.loadBundled();
  }

  public Parser(Path library, Path jniBridge) throws IOException {
    NativeBridge.load(library, jniBridge);
  }

  /** Complete Ok/Err transport envelope for advanced hosts and parity tools. */
  public JsonNode call(JsonNode envelope) throws IOException {
    byte[] input = JSON.writeValueAsBytes(envelope);
    if (input.length > MAX_REQUEST_BYTES)
      throw new IllegalArgumentException("Binding request exceeds 128 MiB");
    return JSON.readTree(NativeBridge.call(input));
  }

  private JsonNode result(ObjectNode envelope) throws IOException {
    JsonNode response = call(envelope);
    if (response.has("Err")) throw new ParserError(response.get("Err"));
    if (!response.has("Ok")) throw new IOException("Invalid native response envelope");
    return response.get("Ok");
  }

  private JsonNode run(String action, String operation, Source source, JsonNode options)
      throws IOException {
    ObjectNode request = JSON.createObjectNode().put("operation", operation);
    ObjectNode input =
        request.putObject("input").put("uri", source.uri()).put("generated", source.generated());
    if (source.content() == null) input.putNull("content");
    else input.put("content", source.content());
    request.set("options", options == null ? JSON.createObjectNode() : options);
    ObjectNode envelope = JSON.createObjectNode().put("abiVersion", 1).put("action", action);
    if (action.equals("report")) envelope.put("compact", true);
    envelope.set("request", request);
    JsonNode output = result(envelope);
    return action.equals("report") ? restoreReport(output) : output;
  }

  /** Expand wire positions after decoding; the public report shape stays unchanged. */
  private JsonNode restoreReport(JsonNode output) throws IOException {
    if (!output.isObject() || output.path("wireVersion").asInt() != 1)
      throw new IOException("Unsupported native report wire version");
    ((ObjectNode) output).remove("wireVersion");
    for (JsonNode source : output.path("sources")) {
      JsonNode uri = source.get("uri");
      ObjectNode locations = (ObjectNode) source.get("locations");
      java.util.Iterator<java.util.Map.Entry<String, JsonNode>> entries = locations.fields();
      while (entries.hasNext()) {
        java.util.Map.Entry<String, JsonNode> entry = entries.next();
        JsonNode position = entry.getValue();
        if (position.isObject()) continue;
        ObjectNode location = JSON.createObjectNode().put("pointer", entry.getKey());
        location.set("uri", uri);
        if (position.isArray()) {
          String[] names = {"line", "column", "offset"};
          for (int index = 0; index < names.length; index++) {
            JsonNode value = position.get(index);
            if (value != null && !value.isNull()) location.set(names[index], value);
          }
        }
        entry.setValue(location);
      }
    }
    return output;
  }

  public JsonNode execute(String operation, Source source, JsonNode options) throws IOException {
    return run("report", operation, source, options);
  }

  public JsonNode document(String operation, Source source, JsonNode options) throws IOException {
    return run("document", operation, source, options);
  }

  public JsonNode parse(Source source, JsonNode options) throws IOException {
    return execute("parse", source, options);
  }

  public JsonNode resolve(Source source, JsonNode options) throws IOException {
    return execute("resolve", source, options);
  }

  public JsonNode bundle(Source source, JsonNode options) throws IOException {
    return execute("bundle", source, options);
  }

  public JsonNode dereference(Source source, JsonNode options) throws IOException {
    return execute("dereference", source, options);
  }

  public JsonNode validate(Source source, JsonNode options) throws IOException {
    return execute("validate", source, options);
  }

  public JsonNode inspect(Source source, JsonNode options) throws IOException {
    return execute("inspect", source, options);
  }

  public JsonNode analyze(Source source, JsonNode options) throws IOException {
    return execute("analyze", source, options);
  }

  public String serialize(JsonNode document, String format, JsonNode limits) throws IOException {
    ObjectNode envelope =
        JSON.createObjectNode()
            .put("abiVersion", 1)
            .put("action", "serialize")
            .put("document", JSON.writeValueAsString(document))
            .put("format", format);
    envelope.set("limits", limits == null ? JSON.createObjectNode() : limits);
    return result(envelope).textValue();
  }
}
