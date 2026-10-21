import Foundation
import OctriOpenAPIParser
import XCTest

final class JSONValueTests: XCTestCase {
  func testUnescapedStringsKeepExactUTF8Keys() throws {
    let value = try decode("{\"é\":\"雪😀\",\"é\":\"other\",\"\":\"\"}")
    XCTAssertEqual(value["é"], .string("雪😀"))
    XCTAssertEqual(value["é"], .string("other"))
    XCTAssertEqual(value[""], .string(""))
    XCTAssertEqual(try JSONValue.decode(value.encoded()), value)
    XCTAssertThrowsError(try decode("{\"é\":1,\"é\":2}"))
  }

  func testEscapedStringsUseJSONUnicodeSemantics() throws {
    XCTAssertEqual(try decode("\"\\ud83d\\ude00\""), .string("😀"))
    XCTAssertEqual(try decode("\"\\\"\\\\\\/\\b\\f\\n\\r\\t\""), .string("\"\\/\u{8}\u{c}\n\r\t"))
    for code in UInt8(0)...31 {
      let escaped = String(format: "\"\\u%04x\"", code)
      XCTAssertEqual(try decode(escaped), .string(String(UnicodeScalar(code))))
      XCTAssertThrowsError(try JSONValue.decode(Data([34, code, 34])))
    }
    for token in ["\"\\ud800\"", "\"\\udc00\"", "\"\\ud800\\u0041\"", "\"\\q\"", "\"\\u12\""] {
      XCTAssertThrowsError(try decode(token), token)
    }
    for invalid in [[34, 0xc0, 0xaf, 34], [34, 0xed, 0xa0, 0x80, 34], [34, 0xf0, 0x9f, 34]] {
      XCTAssertThrowsError(try JSONValue.decode(Data(invalid.map(UInt8.init))))
    }
  }

  func testNumbersRetainExactIntegerRangesAndDecimalTokens() throws {
    let tokens = [
      "0", "-0", "1", "-1", "9223372036854775807", "-9223372036854775808",
      "9223372036854775808", "18446744073709551615", "18446744073709551616",
      "-9223372036854775809", "9007199254740993", "9007199254740993.0",
      "1.0", "-0.0", "1e0", "1e+3", "1E-3", "1.25", "1e-300", "1e300", "1e400", "0.100000000000000005", "9007199254740993.25",
    ]
    for token in tokens {
      let expected: JSONValue
      if !token.contains(".") && !token.lowercased().contains("e"), let value = Int64(token) {
        expected = .integer(value)
      } else if !token.contains(".") && !token.lowercased().contains("e"), let value = UInt64(token) {
        expected = .unsigned(value)
      } else {
        expected = .decimal(token)
      }
      XCTAssertEqual(try decode(token), expected, token)
      XCTAssertEqual(try JSONValue.decode(expected.encoded()), expected)
    }
    XCTAssertThrowsError(try JSONValue.decimal("1,2").encoded())
    for token in ["+1", "01", "-01", ".1", "1.", "1e", "1e+", "--1", "NaN", "Infinity"] {
      XCTAssertThrowsError(try decode(token), token)
    }
  }

  func testContainersRejectInvalidSeparatorsAndTrailingTokens() throws {
    for token in ["[1,]", "{\"x\":1,}", "[truefalse]", "[1 2]", "{}[]", "nullx", "{\"x\" 1}"] {
      XCTAssertThrowsError(try decode(token), token)
    }
    XCTAssertEqual(
      try decode(" \n\t[true,false,null,[],{}]\r"),
      .array([.bool(true), .bool(false), .null, .array([]), .object([:])]))
    let tooDeep = String(repeating: "[", count: 513) + "0" + String(repeating: "]", count: 513)
    XCTAssertThrowsError(try decode(tooDeep))
  }

  private func decode(_ text: String) throws -> JSONValue {
    try JSONValue.decode(Data(text.utf8))
  }
}
