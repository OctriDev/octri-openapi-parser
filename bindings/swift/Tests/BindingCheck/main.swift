import Foundation
import OctriOpenAPIParser

@main
struct Check {
  static func main() async throws {
    let parser = try Parser(library: CommandLine.arguments[1])
    let unicode = try JSONValue.decode(
      Data("{\"é\":1,\"e\\u0301\":2,\"big\":18446744073709551615}".utf8))
    guard unicode["é"] == .integer(1), unicode["e\u{301}"] == .integer(2),
      unicode["big"] == .unsigned(UInt64.max)
    else { throw Failure("literal Unicode keys and uint64") }
    guard try JSONValue.decode(unicode.encoded()) == unicode else {
      throw Failure("Unicode roundtrip")
    }
    guard try JSONValue.decode(Data("1e400".utf8)) == .decimal("1e400") else {
      throw Failure("exact decimal exponent")
    }
    for malformed in ["{\"x\":1,}", "[1,]", "{\"x\":1,\"x\":2}", "\"\\q\"", "01"] {
      do {
        _ = try JSONValue.decode(Data(malformed.utf8))
        throw Failure("Invalid JSON accepted")
      } catch is Failure { throw Failure("Invalid JSON accepted") } catch {}
    }
    let source = Source.text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n")
    for operation in [
      "parse", "resolve", "bundle", "dereference", "validate", "inspect", "analyze",
    ] {
      guard try parser.execute(operation, source: source)["valid"] == .bool(true) else {
        throw Failure(operation)
      }
    }
    guard
      try parser.document("parse", source: source)["document"]?["info"]?["title"] == .string("雪")
    else { throw Failure("document") }
    let report = try parser.parse(source)
    guard let document = report["document"],
      try parser.serialize(document, format: "yaml").contains("openapi:")
    else { throw Failure("writer") }
    do {
      _ = try parser.validate(.text("{}"))
      throw Failure("Invalid input accepted")
    } catch let error as ParserError {
      guard error.diagnostics != .array([]) else { throw Failure("diagnostics") }
    }
    try await withThrowingTaskGroup(of: Bool.self) { group in
      for _ in 0..<32 { group.addTask { try parser.validate(source)["valid"] == .bool(true) } }
      for try await valid in group { if !valid { throw Failure("concurrency") } }
    }
    while let line = readLine() {
      let request = try JSONValue.decode(Data(line.utf8))
      let response = try parser.call(request)
      if request["action"] == .string("report"), let expected = response["Ok"],
        let reportRequest = request["request"],
        case .string(let operation) = reportRequest["operation"],
        let input = reportRequest["input"], case .string(let uri) = input["uri"],
        input["generated"] != .bool(true)
      {
        let content: String?
        if case .string(let value) = input["content"] { content = value } else { content = nil }
        let source: Source
        if let content {
          source = Source.text(content, uri: uri)
        } else {
          source = Source.path(URL(string: uri) ?? URL(fileURLWithPath: uri))
        }
        let options: [JSONKey: JSONValue]
        if case .object(let value) = reportRequest["options"] {
          options = value
        } else {
          options = [:]
        }
        guard try parser.execute(operation, source: source, options: options) == expected else {
          throw Failure("compact facade differs from full native report")
        }
      }
      print(String(decoding: try response.encoded(), as: UTF8.self))
    }
  }
}
struct Failure: Error {
  let message: String
  init(_ message: String) { self.message = message }
}
