<?php

declare(strict_types=1);

namespace Octri\OpenAPI;

require_once __DIR__ . '/ExactJSON.php';

use FFI;
use RuntimeException;
use InvalidArgumentException;
use stdClass;

final class ParserError extends RuntimeException
{
    public function __construct(public readonly array $diagnostics, string $message)
    {
        parent::__construct($message);
    }
}

final class Source
{
    public static function text(string $content, string $uri = 'memory://octri/openapi.yaml'): array
    {
        return ['uri' => $uri, 'content' => $content, 'generated' => false];
    }

    public static function path(string $path): array
    {
        $absolute = realpath($path);
        if ($absolute === false) {
            throw new InvalidArgumentException('Source path does not exist');
        }
        return ['uri' => $absolute, 'content' => null, 'generated' => false];
    }

    public static function object(stdClass $document, string $uri = 'memory://octri/openapi.json'): array
    {
        return ['uri' => $uri, 'content' => json_encode($document, JSON_THROW_ON_ERROR), 'generated' => true];
    }
}

final class Parser
{
    private FFI $native;

    public function __construct(string $library)
    {
        $path = realpath($library);
        if ($path === false) {
            throw new InvalidArgumentException('Native library does not exist');
        }
        $this->native = FFI::cdef('typedef struct OctriParserBuffer OctriParserBuffer;
            unsigned int octri_parser_abi_version(void);
            OctriParserBuffer *octri_parser_call(const char *data, size_t length);
            unsigned char *octri_parser_buffer_data(OctriParserBuffer *buffer);
            size_t octri_parser_buffer_len(const OctriParserBuffer *buffer);
            void octri_parser_buffer_free(OctriParserBuffer *buffer);', $path);
        if ($this->native->octri_parser_abi_version() !== 1) {
            throw new RuntimeException('Expected Octri native ABI version 1');
        }
    }

    // Objects stay stdClass: decoding {} as [] would change JSON semantics.
    public function callJson(array|stdClass $envelope): string
    {
        $input = json_encode($envelope, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        if (strlen($input) > 128 * 1024 * 1024) {
            throw new InvalidArgumentException('Binding request exceeds 128 MiB');
        }
        $result = $this->native->octri_parser_call($input, strlen($input));
        if (FFI::isNull($result)) {
            throw new RuntimeException('Native parser returned a null buffer');
        }
        try {
            $bytes = FFI::string($this->native->octri_parser_buffer_data($result), $this->native->octri_parser_buffer_len($result));
            return $bytes;
        } finally {
            $this->native->octri_parser_buffer_free($result);
        }
    }

    // Use callJson when unsigned integers outside PHP's signed range must stay
    // exact. This decoded API follows PHP's documented JSON number model.
    public function call(array|stdClass $envelope): stdClass
    {
        return ExactJSON::decode($this->callJson($envelope));
    }

    private function result(array $envelope): mixed
    {
        $result = $this->call($envelope);
        if (property_exists($result, 'Err')) {
            throw new ParserError($result->Err->diagnostics, $result->Err->message);
        }
        if (!property_exists($result, 'Ok')) {
            throw new RuntimeException('Invalid native response envelope');
        }
        return $result->Ok;
    }

    public function execute(string $operation, array $source, ?stdClass $options = null): stdClass
    {
        return $this->result(['abiVersion' => 1, 'action' => 'report', 'request' => ['operation' => $operation, 'input' => $source, 'options' => $options ?? new stdClass()]]);
    }

    public function document(string $operation, array $source, ?stdClass $options = null): stdClass
    {
        return $this->result(['abiVersion' => 1, 'action' => 'document', 'request' => ['operation' => $operation, 'input' => $source, 'options' => $options ?? new stdClass()]]);
    }

    public function parse(array $source, ?stdClass $options = null): stdClass
    {
        return $this->execute('parse', $source, $options);
    }
    public function resolve(array $source, ?stdClass $options = null): stdClass
    {
        return $this->execute('resolve', $source, $options);
    }
    public function bundle(array $source, ?stdClass $options = null): stdClass
    {
        return $this->execute('bundle', $source, $options);
    }
    public function dereference(array $source, ?stdClass $options = null): stdClass
    {
        return $this->execute('dereference', $source, $options);
    }
    public function validate(array $source, ?stdClass $options = null): stdClass
    {
        return $this->execute('validate', $source, $options);
    }
    public function inspect(array $source, ?stdClass $options = null): stdClass
    {
        return $this->execute('inspect', $source, $options);
    }
    public function analyze(array $source, ?stdClass $options = null): stdClass
    {
        return $this->execute('analyze', $source, $options);
    }

    public function serialize(mixed $document, string $format = 'json', ?stdClass $limits = null): string
    {
        return $this->result(['abiVersion' => 1, 'action' => 'serialize', 'document' => json_encode($document, JSON_THROW_ON_ERROR), 'format' => $format, 'limits' => $limits ?? new stdClass()]);
    }
}
