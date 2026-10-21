# frozen_string_literal: true

require_relative 'lib/octri_parser'

parser = OctriParser::Parser.new(ARGV.fetch(0))
source = OctriParser::Source.text("openapi: 3.1.2\ninfo: {title: 雪, version: '1'}\npaths: {}\n")
%w[parse resolve bundle dereference validate inspect analyze].each do |operation|
  raise operation unless parser.public_send(operation, source).fetch('valid')
end
raise 'document' unless parser.document('parse', source).fetch('document').dig('info', 'title') == '雪'
raise 'serialize' unless parser.serialize(parser.parse(source).fetch('document'), format: 'yaml').include?('openapi:')

begin
  parser.validate(OctriParser::Source.text('{}'))
  raise 'invalid input accepted'
rescue OctriParser::ParserError => e
  raise 'missing diagnostics' if e.diagnostics.empty?
end
8.times.map do
  Thread.new do
    4.times do
      raise 'concurrent call' unless parser.validate(source).fetch('valid')
    end
  end
end.each(&:value)
$stdin.each_line { |line| puts OctriExactJSON.generate(parser.call(OctriExactJSON.parse(line))) }
