import com.fasterxml.jackson.databind.ObjectMapper
import dev.octri.parser.ParserError
import dev.octri.parser.Source
import dev.octri.parser.kotlin.Parser
import java.nio.file.Path
import java.util.concurrent.Callable
import java.util.concurrent.Executors

fun main(args: Array<String>) {
  val parser = Parser(Path.of(args[0]), Path.of(args[1]))
  val json = ObjectMapper()
  val source = Source.text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n")
  listOf("parse", "resolve", "bundle", "dereference", "validate", "inspect", "analyze").forEach {
    check(parser.execute(it, source).path("valid").asBoolean())
  }
  check(
    parser.document("parse", source).path("document").path("info").path("title").asText() == "雪"
  )
  check(parser.serialize(parser.parse(source).path("document"), "yaml").contains("openapi:"))
  try {
    parser.validate(Source.text("{}"))
    error("Invalid input accepted")
  } catch (error: ParserError) {
    check(!error.diagnostics().isEmpty)
  }
  val pool = Executors.newFixedThreadPool(8)
  try {
    pool
      .invokeAll(List(32) { Callable { parser.validate(source).path("valid").asBoolean() } })
      .forEach { check(it.get()) }
  } finally {
    pool.shutdown()
  }
  System.`in`.bufferedReader(Charsets.UTF_8).lineSequence().forEach {
    System.out.write(parser.call(json.readTree(it)).toString().toByteArray(Charsets.UTF_8))
    System.out.write(10)
  }
}
