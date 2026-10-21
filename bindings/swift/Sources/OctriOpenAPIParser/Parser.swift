import COctri
import Foundation

public struct Source: Codable, Sendable {
  public let uri: String
  public let content: String?
  public let generated: Bool

  public static func text(_ content: String, uri: String = "memory://octri/openapi.yaml") -> Source
  {
    Source(uri: uri, content: content, generated: false)
  }
  public static func path(_ url: URL) -> Source {
    Source(uri: url.absoluteString, content: nil, generated: false)
  }
  public static func object(_ document: JSONValue, uri: String = "memory://octri/openapi.json")
    throws -> Source
  {
    Source(
      uri: uri, content: String(decoding: try document.encoded(), as: UTF8.self),
      generated: true)
  }
}

public struct ParserError: Error, Sendable {
  public let message: String
  public let diagnostics: JSONValue
}

/// Stateless synchronous native binding. Reports and graph arenas use JSONValue;
/// reference resolution is never repeated in Swift. Calls can run concurrently.
public struct Parser: Sendable {
  public init() throws {
    guard octri_parser_abi_version() == 1 else {
      throw ParserError(message: "Expected Octri native ABI version 1", diagnostics: .array([]))
    }
  }

  public func call(_ envelope: JSONValue) throws -> JSONValue {
    let input = try envelope.encoded()
    let output = try callBytes(input)
    return try JSONValue.decode(output)
  }

  private func callBytes(_ input: Data) throws -> Data {
    guard input.count <= 128 * 1024 * 1024 else {
      throw ParserError(message: "Binding request exceeds 128 MiB", diagnostics: .array([]))
    }
    let result = input.withUnsafeBytes { bytes in
      octri_parser_call(bytes.bindMemory(to: UInt8.self).baseAddress, input.count)
    }
    guard let result else {
      throw ParserError(message: "Native parser returned a null buffer", diagnostics: .array([]))
    }
    defer { octri_parser_buffer_free(result) }
    let count = octri_parser_buffer_len(result)
    guard let bytes = octri_parser_buffer_data(result) else {
      throw ParserError(message: "Native parser returned null data", diagnostics: .array([]))
    }
    // Data copies before Rust releases its allocation.
    return Data(bytes: bytes, count: count)
  }

  private func result(_ envelope: JSONValue) throws -> JSONValue {
    let response = try call(envelope)
    if let error = response["Err"] {
      let message: String
      if case .string(let text) = error["message"] {
        message = text
      } else {
        message = "Parser failed"
      }
      throw ParserError(message: message, diagnostics: error["diagnostics"] ?? .array([]))
    }
    guard let value = response["Ok"] else {
      throw ParserError(message: "Invalid native response envelope", diagnostics: .array([]))
    }
    return value
  }

  private func run(
    _ action: String, _ operation: String, _ source: Source, _ options: [JSONKey: JSONValue]
  ) throws -> JSONValue {
    let input = JSONValue.object([
      "uri": .string(source.uri),
      "content": source.content.map(JSONValue.string) ?? .null,
      "generated": .bool(source.generated),
    ])
    var envelope: [JSONKey: JSONValue] = [
      "abiVersion": .integer(1), "action": .string(action),
      "request": .object([
        "operation": .string(operation), "input": input, "options": .object(options),
      ]),
    ]
    if action == "report" { envelope["compact"] = .bool(true) }
    let output = try result(.object(envelope))
    return action == "report" ? try restoreReport(output) : output
  }

  private func restoreReport(_ value: JSONValue) throws -> JSONValue {
    guard case .object(var report) = value, report["wireVersion"] == .integer(1),
      case .array(let sources) = report["sources"]
    else {
      throw ParserError(message: "Unsupported native report wire version", diagnostics: .array([]))
    }
    report.removeValue(forKey: "wireVersion")
    report["sources"] = .array(
      try sources.map { source in
        guard case .object(var fields) = source, let uri = fields["uri"],
          case .object(let positions) = fields["locations"]
        else {
          throw ParserError(message: "Invalid native source transport", diagnostics: .array([]))
        }
        var locations: [JSONKey: JSONValue] = [:]
        locations.reserveCapacity(positions.count)
        for (pointer, position) in positions {
          if case .object = position {
            locations[pointer] = position
            continue
          }
          var location: [JSONKey: JSONValue] = ["uri": uri, "pointer": .string(pointer.text)]
          if case .array(let values) = position {
            for (key, value) in zip(["line", "column", "offset"], values) where value != .null {
              location[JSONKey(key)] = value
            }
          }
          locations[pointer] = .object(location)
        }
        fields["locations"] = .object(locations)
        return .object(fields)
      })
    return .object(report)
  }

  public func execute(_ operation: String, source: Source, options: [JSONKey: JSONValue] = [:])
    throws -> JSONValue
  { try run("report", operation, source, options) }
  public func document(_ operation: String, source: Source, options: [JSONKey: JSONValue] = [:])
    throws -> JSONValue
  { try run("document", operation, source, options) }
  public func parse(_ source: Source, options: [JSONKey: JSONValue] = [:]) throws -> JSONValue {
    try execute("parse", source: source, options: options)
  }
  public func resolve(_ source: Source, options: [JSONKey: JSONValue] = [:]) throws -> JSONValue {
    try execute("resolve", source: source, options: options)
  }
  public func bundle(_ source: Source, options: [JSONKey: JSONValue] = [:]) throws -> JSONValue {
    try execute("bundle", source: source, options: options)
  }
  public func dereference(_ source: Source, options: [JSONKey: JSONValue] = [:]) throws -> JSONValue
  { try execute("dereference", source: source, options: options) }
  public func validate(_ source: Source, options: [JSONKey: JSONValue] = [:]) throws -> JSONValue {
    try execute("validate", source: source, options: options)
  }
  public func inspect(_ source: Source, options: [JSONKey: JSONValue] = [:]) throws -> JSONValue {
    try execute("inspect", source: source, options: options)
  }
  public func analyze(_ source: Source, options: [JSONKey: JSONValue] = [:]) throws -> JSONValue {
    try execute("analyze", source: source, options: options)
  }

  public func serialize(
    _ document: JSONValue, format: String = "json", limits: [JSONKey: JSONValue] = [:]
  ) throws -> String {
    let text = String(decoding: try document.encoded(), as: UTF8.self)
    let output = try result(
      .object([
        "abiVersion": .integer(1), "action": .string("serialize"), "document": .string(text),
        "format": .string(format), "limits": .object(limits),
      ]))
    guard case .string(let value) = output else {
      throw ParserError(
        message: "Native writer returned non-string output", diagnostics: .array([]))
    }
    return value
  }
}
