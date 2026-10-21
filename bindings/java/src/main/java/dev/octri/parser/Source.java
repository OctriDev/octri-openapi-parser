package dev.octri.parser;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.util.Objects;

/** Explicit text, object or native path; no string-content guessing. */
public final class Source {
  private final String uri;
  private final String content;
  private final boolean generated;

  public Source(String uri, String content, boolean generated) {
    this.uri = Objects.requireNonNull(uri, "uri");
    this.content = content;
    this.generated = generated;
  }

  public String uri() {
    return uri;
  }

  public String content() {
    return content;
  }

  public boolean generated() {
    return generated;
  }

  @Override
  public boolean equals(Object other) {
    if (this == other) return true;
    if (!(other instanceof Source)) return false;
    Source source = (Source) other;
    return generated == source.generated
        && uri.equals(source.uri)
        && Objects.equals(content, source.content);
  }

  @Override
  public int hashCode() {
    return Objects.hash(uri, content, generated);
  }

  @Override
  public String toString() {
    return "Source[uri=" + uri + ", content=" + content + ", generated=" + generated + "]";
  }

  public static Source text(String text) {
    return text(text, "memory://octri/openapi.yaml");
  }

  public static Source text(String text, String uri) {
    return new Source(uri, Objects.requireNonNull(text), false);
  }

  public static Source path(Path path) {
    return new Source(path.toAbsolutePath().toString(), null, false);
  }

  public static Source object(JsonNode document, String uri) {
    return new Source(uri, Objects.requireNonNull(document).toString(), true);
  }
}
