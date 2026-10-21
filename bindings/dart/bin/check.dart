import 'dart:convert';
import 'dart:io';
import 'dart:isolate';
import '../lib/octri_openapi_parser.dart';

void check(bool condition) {
  if (!condition) throw StateError('Binding consumer assertion failed');
}

Future<void> main(List<String> arguments) async {
  final library = arguments.single;
  final parser = Parser(library);
  final source = Source.text(
    "openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n",
  );
  for (final operation in [
    'parse',
    'resolve',
    'bundle',
    'dereference',
    'validate',
    'inspect',
    'analyze',
  ]) {
    check(parser.execute(operation, source)['valid'] == true);
  }
  check(
    (parser.document('parse', source)['document'] as Map)['info']['title'] ==
        '雪',
  );
  check(
    parser
        .serialize(parser.parse(source)['document'], format: 'yaml')
        .contains('openapi:'),
  );
  try {
    parser.validate(Source.text('{}'));
    throw StateError('Invalid input accepted');
  } on ParserException catch (error) {
    check(error.diagnostics.isNotEmpty);
  }
  final large = <String, Object?>{
    'abiVersion': 1,
    'action': 'report',
    'request': {
      'operation': 'parse',
      'input': Source.text(
              '{"openapi":"3.1.2","info":{"title":"Integer","version":"1"},"paths":{},"x-integer":18446744073709551615}')
          .toJson()
    },
  };
  check(parser.callJson(large).contains('18446744073709551615'));
  try {
    parser.call(large);
    throw StateError('Lossy Dart decoding was accepted');
  } on LosslessNumberException catch (error) {
    check(error.code == 'LOSSLESS_NUMBER_REQUIRED');
  }
  check(
    (await Future.wait(
      List.generate(
        8,
        (_) => Isolate.run(() {
          final parser = Parser(library);
          for (var index = 0; index < 4; index++) {
            if (parser.validate(
                  Source.text(
                    "openapi: 3.1.2\ninfo: {title: Isolate, version: '1'}\npaths: {}\n",
                  ),
                )['valid'] !=
                true) return false;
          }
          return true;
        }),
      ),
    ))
        .every((valid) => valid),
  );
  await for (final line
      in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
    print(parser.callJson(
        (jsonDecode(line) as Map<String, dynamic>).cast<String, Object?>()));
  }
}
