package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	parser "github.com/octridev/octri-openapi-parser-go"
	"os"
)

func main() {
	p := parser.Parser{}
	source := parser.Text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n", "memory://octri/openapi.yaml")
	for _, operation := range []string{"parse", "resolve", "bundle", "dereference", "validate", "inspect", "analyze"} {
		report, err := p.Execute(parser.Request{Operation: operation, Input: source})
		if err != nil || !report.Valid {
			panic(fmt.Sprintf("%s: %v", operation, err))
		}
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), parser.MaxRequestBytes)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	for scanner.Scan() {
		result, err := p.Call(json.RawMessage(scanner.Bytes()))
		if err != nil {
			panic(err)
		}
		fmt.Fprintln(out, string(result))
	}
	if err := scanner.Err(); err != nil {
		panic(err)
	}
}
