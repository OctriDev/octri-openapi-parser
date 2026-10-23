// Package parser calls Octri's Rust parser through its versioned C ABI.
// Build with CGO_ENABLED=1. Released modules link the static library under
// lib/<goos>_<goarch>; elsewhere, add its directory to CGO_LDFLAGS with -L.
package parser

/*
#cgo LDFLAGS: -loctri_parser_ffi
#cgo darwin,arm64 LDFLAGS: -L${SRCDIR}/lib/darwin_arm64 -framework Security -framework CoreFoundation -liconv
#cgo linux,amd64 LDFLAGS: -L${SRCDIR}/lib/linux_amd64 -lgcc_s -lutil -lrt -lpthread -lm -ldl
#cgo linux,arm64 LDFLAGS: -L${SRCDIR}/lib/linux_arm64 -lgcc_s -lutil -lrt -lpthread -lm -ldl
#include "octri_parser.h"
*/
import "C"

import (
	"encoding/json"
	"errors"
	"runtime"
	"unsafe"
)

const MaxRequestBytes = 128 * 1024 * 1024

type Source struct {
	URI       string  `json:"uri"`
	Content   *string `json:"content"`
	Generated bool    `json:"generated"`
}

func Text(content, uri string) Source { return Source{URI: uri, Content: &content} }
func Path(path string) Source         { return Source{URI: path} }
func Object(document json.RawMessage, uri string) (Source, error) {
	if !json.Valid(document) {
		return Source{}, errors.New("document is not valid JSON")
	}
	content := string(document)
	return Source{URI: uri, Content: &content, Generated: true}, nil
}

type Location struct {
	URI     string `json:"uri"`
	Pointer string `json:"pointer"`
	Line    *int   `json:"line,omitempty"`
	Column  *int   `json:"column,omitempty"`
	Offset  *int   `json:"offset,omitempty"`
}

type Diagnostic struct {
	Code     string     `json:"code"`
	Severity string     `json:"severity"`
	Message  string     `json:"message"`
	Location Location   `json:"location"`
	Related  []Location `json:"related,omitempty"`
}

type ParserError struct {
	Message     string       `json:"message"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

func (e *ParserError) Error() string { return e.Message }

// JSON fields preserve empty objects, exact JSON numbers and graph IDs. Decode
// into application types when needed, rather than rounding all numbers to float64.
type Report struct {
	Valid       bool            `json:"valid"`
	Dialect     *string         `json:"dialect"`
	Document    json.RawMessage `json:"document"`
	Diagnostics []Diagnostic    `json:"diagnostics"`
	Sources     json.RawMessage `json:"sources"`
	References  json.RawMessage `json:"references"`
	Registry    json.RawMessage `json:"registry"`
	Inspection  json.RawMessage `json:"inspection,omitempty"`
	Graph       json.RawMessage `json:"graph,omitempty"`
}

type Request struct {
	Operation string          `json:"operation"`
	Input     Source          `json:"input"`
	Options   json.RawMessage `json:"options,omitempty"`
}

type DocumentOutput struct {
	Document json.RawMessage `json:"document"`
	Graph    json.RawMessage `json:"graph"`
}

type Parser struct{}

// withOutput borrows pointer-free Go bytes only for the C call and releases
// native output after the callback finishes.
func (Parser) withOutput(envelope []byte, consume func([]byte) error) error {
	if C.octri_parser_abi_version() != 1 {
		return errors.New("expected Octri native ABI version 1")
	}
	if len(envelope) > MaxRequestBytes {
		return errors.New("binding request exceeds 128 MiB")
	}
	var data *C.uint8_t
	if len(envelope) != 0 {
		data = (*C.uint8_t)(unsafe.Pointer(&envelope[0]))
	}
	result := C.octri_parser_call(data, C.size_t(len(envelope)))
	runtime.KeepAlive(envelope)
	if result == nil {
		return errors.New("native parser returned a null buffer")
	}
	defer C.octri_parser_buffer_free(result)
	length := C.octri_parser_buffer_len(result)
	if uint64(length) > uint64(^uint(0)>>1) {
		return errors.New("native result exceeds Go slice limit")
	}
	borrowed := unsafe.Slice((*byte)(unsafe.Pointer(C.octri_parser_buffer_data(result))), int(length))
	// The callback must finish before Rust frees its output. JSON unmarshalling
	// copies retained RawMessage fields, so no native allocation escapes here.
	return consume(borrowed)
}

// Call exposes the complete envelope for transport/parity tooling.
func (p Parser) Call(envelope json.RawMessage) (json.RawMessage, error) {
	var output json.RawMessage
	err := p.withOutput(envelope, func(borrowed []byte) error {
		if !json.Valid(borrowed) {
			return errors.New("native parser returned invalid JSON")
		}
		output = append(json.RawMessage(nil), borrowed...)
		return nil
	})
	return output, err
}

// Decode the public result directly from its envelope. Keeping Ok as T avoids
// copying and scanning a large report once as RawMessage and again as Report.
func result[T any](p Parser, envelope interface{}) (*T, error) {
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	var response struct {
		Ok  *T
		Err *ParserError
	}
	if err = p.withOutput(encoded, func(output []byte) error {
		return json.Unmarshal(output, &response)
	}); err != nil {
		return nil, err
	}
	if response.Err != nil {
		return nil, response.Err
	}
	if response.Ok == nil {
		return nil, errors.New("invalid native response envelope")
	}
	return response.Ok, nil
}

func (p Parser) Execute(request Request) (*Report, error) {
	report, err := result[Report](p, struct {
		ABIVersion int     `json:"abiVersion"`
		Action     string  `json:"action"`
		Request    Request `json:"request"`
	}{1, "report", request})
	if err != nil {
		return nil, err
	}
	return report, nil
}

func (p Parser) Document(request Request) (*DocumentOutput, error) {
	document, err := result[DocumentOutput](p, struct {
		ABIVersion int     `json:"abiVersion"`
		Action     string  `json:"action"`
		Request    Request `json:"request"`
	}{1, "document", request})
	if err != nil {
		return nil, err
	}
	return document, nil
}

func (p Parser) Parse(source Source, options json.RawMessage) (*Report, error) {
	return p.Execute(Request{"parse", source, options})
}
func (p Parser) Resolve(source Source, options json.RawMessage) (*Report, error) {
	return p.Execute(Request{"resolve", source, options})
}
func (p Parser) Bundle(source Source, options json.RawMessage) (*Report, error) {
	return p.Execute(Request{"bundle", source, options})
}
func (p Parser) Dereference(source Source, options json.RawMessage) (*Report, error) {
	return p.Execute(Request{"dereference", source, options})
}
func (p Parser) Validate(source Source, options json.RawMessage) (*Report, error) {
	return p.Execute(Request{"validate", source, options})
}
func (p Parser) Inspect(source Source, options json.RawMessage) (*Report, error) {
	return p.Execute(Request{"inspect", source, options})
}
func (p Parser) Analyze(source Source, options json.RawMessage) (*Report, error) {
	return p.Execute(Request{"analyze", source, options})
}

func (p Parser) Serialize(document json.RawMessage, format string, limits json.RawMessage) (string, error) {
	text, err := result[string](p, struct {
		ABIVersion int             `json:"abiVersion"`
		Action     string          `json:"action"`
		Document   string          `json:"document"`
		Format     string          `json:"format"`
		Limits     json.RawMessage `json:"limits,omitempty"`
	}{1, "serialize", string(document), format, limits})
	if err != nil {
		return "", err
	}
	return *text, nil
}
