package dev.octri.parser.kotlin

import com.fasterxml.jackson.databind.JsonNode
import dev.octri.parser.Source
import java.nio.file.Path

/**
 * Kotlin facade shares the Java JNI bridge and the same native parser. Calls block the current
 * thread. Use your application's dispatcher for large requests; coroutine cancellation cannot
 * terminate synchronous native execution.
 */
class Parser(library: Path, jniBridge: Path) {
  private val native = dev.octri.parser.Parser(library, jniBridge)

  fun call(envelope: JsonNode): JsonNode = native.call(envelope)

  fun execute(operation: String, source: Source, options: JsonNode? = null): JsonNode =
    native.execute(operation, source, options)

  fun document(operation: String, source: Source, options: JsonNode? = null): JsonNode =
    native.document(operation, source, options)

  fun parse(source: Source, options: JsonNode? = null): JsonNode = native.parse(source, options)

  fun resolve(source: Source, options: JsonNode? = null): JsonNode = native.resolve(source, options)

  fun bundle(source: Source, options: JsonNode? = null): JsonNode = native.bundle(source, options)

  fun dereference(source: Source, options: JsonNode? = null): JsonNode =
    native.dereference(source, options)

  fun validate(source: Source, options: JsonNode? = null): JsonNode =
    native.validate(source, options)

  fun inspect(source: Source, options: JsonNode? = null): JsonNode = native.inspect(source, options)

  fun analyze(source: Source, options: JsonNode? = null): JsonNode = native.analyze(source, options)

  fun serialize(document: JsonNode, format: String = "json", limits: JsonNode? = null): String =
    native.serialize(document, format, limits)
}
