package parser

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestConcurrentCallsAndRecovery(t *testing.T) {
	p := Parser{}
	source := Text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n", "memory://test/api.yaml")
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			report, err := p.Validate(source, nil)
			if err != nil || !report.Valid {
				t.Errorf("concurrent request failed: %v", err)
			}
		}()
	}
	workers.Wait()
	_, err := p.Validate(Text("{}", "memory://test/invalid.json"), nil)
	var diagnostic *ParserError
	if !errors.As(err, &diagnostic) || len(diagnostic.Diagnostics) == 0 {
		t.Fatalf("missing structured error: %v", err)
	}
	report, err := p.Analyze(source, nil)
	if err != nil || !report.Valid {
		t.Fatalf("failed recovery: %v", err)
	}
	document, err := p.Document(Request{Operation: "parse", Input: source})
	if err != nil || !json.Valid(document.Document) {
		t.Fatalf("document projection: %v", err)
	}
	yaml, err := p.Serialize(report.Document, "yaml", nil)
	if err != nil || !strings.Contains(yaml, "openapi:") {
		t.Fatalf("writer: %v", err)
	}
}

func TestTypedReportMatchesEnvelopeAndOwnsRetainedJSON(t *testing.T) {
	p := Parser{}
	request := Request{
		Operation: "analyze",
		Input:     Text(`{"openapi":"3.1.2","info":{"title":"é/é/雪","version":"1"},"paths":{},"x-number":18446744073709551615}`, "memory://test/ownership.json"),
		Options:   json.RawMessage(`{"validate":{"mode":"strict"}}`),
	}
	envelope, err := json.Marshal(map[string]interface{}{"abiVersion": 1, "action": "report", "request": request})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := p.Call(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var expected struct{ Ok *Report }
	if err := json.Unmarshal(raw, &expected); err != nil || expected.Ok == nil {
		t.Fatalf("raw envelope: %v", err)
	}
	actual, err := p.Execute(request)
	if err != nil || !reflect.DeepEqual(actual, expected.Ok) {
		t.Fatalf("typed report differs from public envelope: %v", err)
	}
	before, err := json.Marshal(actual)
	if err != nil {
		t.Fatal(err)
	}
	// Later native calls allocate/free buffers of different sizes. The first
	// report's RawMessage fields must remain valid after those buffers are reused.
	for i := 0; i < 64; i++ {
		_, err := p.Parse(Text(strings.Repeat("\n", i)+`{"openapi":"3.1.2","info":{"title":"later","version":"1"},"paths":{}}`, "memory://test/later.json"), nil)
		if err != nil {
			t.Fatal(err)
		}
	}
	after, err := json.Marshal(actual)
	if err != nil || string(before) != string(after) || !json.Valid(raw) {
		t.Fatalf("retained JSON changed after native output was released: %v", err)
	}
}
