"""Synchronous, stateless Python bindings. Parser semantics live in Rust."""

from __future__ import annotations

import ctypes
import sys
from . import _json as exact_json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Union

Operation = Literal[
    "parse", "resolve", "bundle", "dereference", "validate", "inspect", "analyze"
]
JsonObject = Dict[str, Any]
MAX_REQUEST_BYTES = 128 * 1024 * 1024
# Platform wheels carry the native library next to this module.
BUNDLED_LIBRARY = Path(__file__).with_name("native") / (
    "liboctri_parser_ffi.dylib"
    if sys.platform == "darwin"
    else "liboctri_parser_ffi.so"
)


def _restore_report(report: JsonObject) -> JsonObject:
    """Expand compact transport positions without repeating source URI strings."""
    if report.pop("wireVersion", None) != 1:
        raise RuntimeError("Unsupported native report wire version")
    for source in report["sources"]:
        uri = source["uri"]
        locations = source["locations"]
        for pointer, position in locations.items():
            if isinstance(position, dict):
                continue
            location = {"uri": uri, "pointer": pointer}
            if position is not None:
                for key, value in zip(("line", "column", "offset"), position):
                    if value is not None:
                        location[key] = value
            locations[pointer] = location
    return report


class ParserError(Exception):
    """Structured Rust diagnostics, including source and related locations."""

    def __init__(self, error: JsonObject):
        super().__init__(error["message"])
        self.diagnostics: List[JsonObject] = error["diagnostics"]


@dataclass(frozen=True)
class Source:
    uri: str
    content: Optional[str]
    generated: bool = False

    @classmethod
    def text(cls, content: str, uri: str = "memory://octri/openapi.yaml") -> Source:
        return cls(uri, content)

    @classmethod
    def path(cls, path: Union[str, Path]) -> Source:
        return cls(str(Path(path).absolute()), None)

    @classmethod
    def object(
        cls, document: JsonObject, uri: str = "memory://octri/openapi.json"
    ) -> Source:
        return cls(uri, exact_json.dumps(document), True)

    def request(self) -> JsonObject:
        return {"uri": self.uri, "content": self.content, "generated": self.generated}


class Parser:
    """Reusable across threads: each call owns independent native/parser state.

    Reports are ordinary JSON dictionaries. Their graph arenas retain shared and
    circular node IDs; no tree expansion or reference resolution occurs in Python.
    Content never grants filesystem authority from its URI.
    """

    def __init__(self, library: Union[str, Path, None] = None):
        path = Path(library) if library is not None else BUNDLED_LIBRARY
        self._library = ctypes.CDLL(str(path.resolve(strict=True)))
        self._library.octri_parser_abi_version.restype = ctypes.c_uint32
        if self._library.octri_parser_abi_version() != 1:
            raise RuntimeError("Expected Octri native ABI version 1")
        self._call = self._library.octri_parser_call
        self._call.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        self._call.restype = ctypes.c_void_p
        self._data = self._library.octri_parser_buffer_data
        self._data.argtypes = [ctypes.c_void_p]
        self._data.restype = ctypes.c_void_p
        self._length = self._library.octri_parser_buffer_len
        self._length.argtypes = [ctypes.c_void_p]
        self._length.restype = ctypes.c_size_t
        self._free = self._library.octri_parser_buffer_free
        self._free.argtypes = [ctypes.c_void_p]
        self._free.restype = None

    def call(self, envelope: JsonObject) -> JsonObject:
        """Low-level versioned transport; preserves Ok/Err for parity tooling."""
        request = exact_json.dumps(envelope).encode(
            "utf-8"
        )
        if len(request) > MAX_REQUEST_BYTES:
            raise ValueError("Binding request exceeds 128 MiB")
        data = ctypes.create_string_buffer(request)
        result = self._call(data, len(request))
        if not result:
            raise MemoryError("Native parser returned a null buffer")
        try:
            output = ctypes.string_at(self._data(result), self._length(result))
        finally:
            self._free(result)
        return exact_json.loads(output)

    def _result(self, envelope: JsonObject) -> Any:
        result = self.call(envelope)
        if "Err" in result:
            raise ParserError(result["Err"])
        return result["Ok"]

    def execute(
        self, operation: Operation, source: Source, options: Optional[JsonObject] = None
    ) -> JsonObject:
        return _restore_report(
            self._result(
                {
                    "abiVersion": 1,
                    "action": "report",
                    "compact": True,
                    "request": {
                        "operation": operation,
                        "input": source.request(),
                        "options": options or {},
                    },
                }
            )
        )

    def document(
        self, operation: Operation, source: Source, options: Optional[JsonObject] = None
    ) -> JsonObject:
        """Parse/bundle document or dereference/validate graph, without reports."""
        return self._result(
            {
                "abiVersion": 1,
                "action": "document",
                "request": {
                    "operation": operation,
                    "input": source.request(),
                    "options": options or {},
                },
            }
        )

    def parse(self, source: Source, options: Optional[JsonObject] = None) -> JsonObject:
        return self.execute("parse", source, options)

    def resolve(self, source: Source, options: Optional[JsonObject] = None) -> JsonObject:
        return self.execute("resolve", source, options)

    def bundle(self, source: Source, options: Optional[JsonObject] = None) -> JsonObject:
        return self.execute("bundle", source, options)

    def dereference(
        self, source: Source, options: Optional[JsonObject] = None
    ) -> JsonObject:
        return self.execute("dereference", source, options)

    def validate(self, source: Source, options: Optional[JsonObject] = None) -> JsonObject:
        return self.execute("validate", source, options)

    def inspect(self, source: Source, options: Optional[JsonObject] = None) -> JsonObject:
        return self.execute("inspect", source, options)

    def analyze(self, source: Source, options: Optional[JsonObject] = None) -> JsonObject:
        return self.execute("analyze", source, options)

    def serialize(
        self,
        document: Any,
        format: Literal["json", "yaml"] = "json",
        limits: Optional[JsonObject] = None,
    ) -> str:
        return self._result(
            {
                "abiVersion": 1,
                "action": "serialize",
                "document": exact_json.dumps(document),
                "format": format,
                "limits": limits or {},
            }
        )
