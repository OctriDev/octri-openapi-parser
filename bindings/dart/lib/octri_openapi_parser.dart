import 'dart:convert';
import 'exact_json.dart';
export 'exact_json.dart' show LosslessNumberException;
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';

final class _Buffer extends Opaque {}

typedef _VersionNative = Uint32 Function();
typedef _Version = int Function();
typedef _NewNative = Pointer<_Buffer> Function(UintPtr);
typedef _New = Pointer<_Buffer> Function(int);
typedef _DataNative = Pointer<Uint8> Function(Pointer<_Buffer>);
typedef _Data = Pointer<Uint8> Function(Pointer<_Buffer>);
typedef _LenNative = UintPtr Function(Pointer<_Buffer>);
typedef _Len = int Function(Pointer<_Buffer>);
typedef _FreeNative = Void Function(Pointer<_Buffer>);
typedef _Free = void Function(Pointer<_Buffer>);
typedef _CallNative = Pointer<_Buffer> Function(Pointer<Uint8>, UintPtr);
typedef _Call = Pointer<_Buffer> Function(Pointer<Uint8>, int);

class ParserException implements Exception {
  final String message;
  final List<Object?> diagnostics;
  ParserException(this.message, this.diagnostics);
  @override
  String toString() => 'ParserException: $message';
}

class Source {
  final String uri;
  final String? content;
  final bool generated;
  const Source._(this.uri, this.content, this.generated);
  factory Source.text(
    String content, {
    String uri = 'memory://octri/openapi.yaml',
  }) =>
      Source._(uri, content, false);
  factory Source.path(String path) =>
      Source._(File(path).absolute.path, null, false);
  factory Source.object(
    Map<String, Object?> document, {
    String uri = 'memory://octri/openapi.json',
  }) =>
      Source._(uri, jsonEncode(document), true);
  Map<String, Object?> toJson() => {
        'uri': uri,
        'content': content,
        'generated': generated,
      };
}

/// Dart native VM binding. Calls block this isolate; run large work in a worker
/// isolate. Graph node IDs preserve cycles/sharing without expanding JSON trees.
/// The library stays loaded for the isolate's lifetime; buffers are freed per call.
class Parser {
  final DynamicLibrary _library;
  late final _New _new = _library.lookupFunction<_NewNative, _New>(
    'octri_parser_buffer_new',
  );
  late final _Data _data = _library.lookupFunction<_DataNative, _Data>(
    'octri_parser_buffer_data',
  );
  late final _Len _length = _library.lookupFunction<_LenNative, _Len>(
    'octri_parser_buffer_len',
  );
  late final _Free _free = _library.lookupFunction<_FreeNative, _Free>(
    'octri_parser_buffer_free',
  );
  late final _Call _call = _library.lookupFunction<_CallNative, _Call>(
    'octri_parser_call',
  );

  /// Without a path, loads the library this package bundles for the host
  /// platform. Compiled executables cannot resolve package files; pass the
  /// library path there.
  Parser([String? library])
      : _library = DynamicLibrary.open(
            File(library ?? _bundledLibrary()).resolveSymbolicLinksSync()) {
    final version = _library.lookupFunction<_VersionNative, _Version>(
      'octri_parser_abi_version',
    );
    if (version() != 1) throw StateError('Expected Octri native ABI version 1');
  }

  static String _bundledLibrary() {
    final arch = switch (Abi.current()) {
      Abi.linuxX64 || Abi.macosX64 => 'x64',
      Abi.linuxArm64 || Abi.macosArm64 => 'arm64',
      final abi => '$abi',
    };
    final os = Platform.isMacOS ? 'darwin' : Platform.operatingSystem;
    final file =
        Platform.isMacOS ? 'liboctri_parser_ffi.dylib' : 'liboctri_parser_ffi.so';
    final uri = Isolate.resolvePackageUriSync(
        Uri.parse('package:octri_openapi_parser/src/native/$os-$arch/$file'));
    if (uri == null)
      throw UnsupportedError(
          'Package files are unavailable; pass the native library path');
    return uri.toFilePath();
  }

  String callJson(Map<String, Object?> envelope) {
    final bytes = utf8.encode(jsonEncode(envelope));
    if (bytes.length > 128 * 1024 * 1024)
      throw ArgumentError('Binding request exceeds 128 MiB');
    final input = _new(bytes.length);
    if (input == nullptr) throw StateError('Native input allocation failed');
    try {
      _data(input).asTypedList(bytes.length).setAll(0, bytes);
      final output = _call(_data(input), bytes.length);
      if (output == nullptr)
        throw StateError('Native parser returned a null buffer');
      try {
        // UTF-8 decoding copies all bytes before native output is freed.
        final text = utf8.decode(_data(output).asTypedList(_length(output)));
        return text;
      } finally {
        _free(output);
      }
    } finally {
      _free(input);
    }
  }

  /// Decoded values follow Dart's number model. callJson preserves native JSON
  /// exactly when unsigned integers outside the signed range are required.
  Map<String, Object?> call(Map<String, Object?> envelope) => decodeExactJson(callJson(envelope));

  Object? _result(Map<String, Object?> envelope) {
    final response = call(envelope);
    if (response.containsKey('Err')) {
      final error = response['Err'] as Map<String, dynamic>;
      throw ParserException(
        error['message'] as String,
        (error['diagnostics'] as List).cast<Object?>(),
      );
    }
    if (!response.containsKey('Ok'))
      throw StateError('Invalid native response envelope');
    return response['Ok'];
  }

  Map<String, Object?> _run(
    String action,
    String operation,
    Source source,
    Map<String, Object?> options,
  ) {
    final result = _result({
      'abiVersion': 1,
      'action': action,
      'request': {
        'operation': operation,
        'input': source.toJson(),
        'options': options,
      },
    });
    return (result as Map<String, dynamic>).cast<String, Object?>();
  }

  Map<String, Object?> execute(
    String operation,
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      _run('report', operation, source, options);
  Map<String, Object?> document(
    String operation,
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      _run('document', operation, source, options);
  Map<String, Object?> parse(
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      execute('parse', source, options: options);
  Map<String, Object?> resolve(
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      execute('resolve', source, options: options);
  Map<String, Object?> bundle(
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      execute('bundle', source, options: options);
  Map<String, Object?> dereference(
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      execute('dereference', source, options: options);
  Map<String, Object?> validate(
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      execute('validate', source, options: options);
  Map<String, Object?> inspect(
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      execute('inspect', source, options: options);
  Map<String, Object?> analyze(
    Source source, {
    Map<String, Object?> options = const {},
  }) =>
      execute('analyze', source, options: options);

  String serialize(
    Object? document, {
    String format = 'json',
    Map<String, Object?> limits = const {},
  }) =>
      _result({
        'abiVersion': 1,
        'action': 'serialize',
        'document': jsonEncode(document),
        'format': format,
        'limits': limits,
      }) as String;
}
