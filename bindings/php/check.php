<?php

declare(strict_types=1);
require __DIR__ . '/src/Parser.php';
use Octri\OpenAPI\Parser;
use Octri\OpenAPI\ParserError;
use Octri\OpenAPI\Source;

function check(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}
$parser = new Parser($argv[1]);
$source = Source::text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n");
foreach (['parse', 'resolve', 'bundle', 'dereference', 'validate', 'inspect', 'analyze'] as $operation) {
    check($parser->$operation($source)->valid, $operation);
}
check($parser->document('parse', $source)->document->info->title === '雪', 'document');
check(str_contains($parser->serialize($parser->parse($source)->document, 'yaml'), 'openapi:'), 'serialize');
try {
    $parser->validate(Source::text('{}'));
    throw new RuntimeException('Invalid document accepted');
} catch (ParserError $error) {
    check(count($error->diagnostics) > 0, 'missing diagnostics');
}
for ($index = 0; $index < 32; $index++) {
    check($parser->validate($source)->valid, 'recovery');
}
$large = ['abiVersion' => 1, 'action' => 'report', 'request' => ['operation' => 'parse', 'input' => Source::text('{"openapi":"3.1.2","info":{"title":"Integer","version":"1"},"paths":{},"x-integer":18446744073709551615}')]];
check(str_contains($parser->callJson($large), '18446744073709551615'), 'lossless unsigned integer JSON');
try {
    $parser->call($large);
    throw new RuntimeException('Lossy PHP decoding was accepted');
} catch (\Octri\OpenAPI\LosslessNumberException $error) {
    check($error->bindingCode === 'LOSSLESS_NUMBER_REQUIRED', 'stable lossless decoding error');
}
foreach (['0.100000000000000005', '1e400'] as $token) {
    try {
        \Octri\OpenAPI\ExactJSON::decode('{"number":' . $token . '}');
        throw new RuntimeException('Lossy decimal decoding was accepted');
    } catch (\Octri\OpenAPI\LosslessNumberException $error) {
        check($error->bindingCode === 'LOSSLESS_NUMBER_REQUIRED', 'exact decimal guard');
    }
}
while (($line = fgets(STDIN)) !== false) {
    // Conformance compares lossless native JSON. High-level host numbers have
    // their own precision contract, checked explicitly below/in consumer tests.
    echo $parser->callJson(json_decode($line, false, 512, JSON_THROW_ON_ERROR)), "\n";
}
