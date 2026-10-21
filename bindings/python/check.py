"""Consumer and JSONL conformance runner; not installed in the package."""

from octri_parser import _json as exact_json
import sys
from concurrent.futures import ThreadPoolExecutor

from octri_parser import Parser, ParserError, Source

parser = Parser(sys.argv[1])
source = Source.text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n")
for operation in (
    "parse",
    "resolve",
    "bundle",
    "dereference",
    "validate",
    "inspect",
    "analyze",
):
    assert getattr(parser, operation)(source)["valid"]
assert parser.document("parse", source)["document"]["info"]["title"] == "雪"
assert "openapi:" in parser.serialize(parser.parse(source)["document"], "yaml")
try:
    parser.validate(Source.text("{}"))
    raise AssertionError("Invalid document accepted")
except ParserError as error:
    assert error.diagnostics[0]["code"]
with ThreadPoolExecutor(max_workers=8) as pool:
    assert all(pool.map(lambda _: parser.validate(source)["valid"], range(32)))
for line in sys.stdin:
    envelope = exact_json.loads(line)
    response = parser.call(envelope)
    if envelope.get("action") == "report" and "Ok" in response:
        request = envelope["request"]
        input_source = request["input"]
        source = Source(input_source["uri"], input_source.get("content"), input_source.get("generated", False))
        actual = parser.execute(request["operation"], source, request.get("options"))
        assert actual == response["Ok"], "compact facade differs from full native report"
    print(
        exact_json.dumps(response)
    )
