# frozen_string_literal: true

require 'fiddle'
require 'json'
require_relative 'exact_json'
require 'pathname'

module OctriParser
  # Native diagnostics retain physical source positions and related locations.
  class ParserError < StandardError
    attr_reader :diagnostics

    def initialize(error)
      super(error.fetch('message'))
      @diagnostics = error.fetch('diagnostics')
    end
  end

  # Explicit sources avoid guessing whether a string is a path or a document.
  class Source
    def self.text(content, uri: 'memory://octri/openapi.yaml')
      { 'uri' => uri, 'content' => content, 'generated' => false }
    end

    def self.path(path)
      { 'uri' => Pathname.new(path).expand_path.to_s, 'content' => nil, 'generated' => false }
    end

    def self.object(document, uri: 'memory://octri/openapi.json')
      { 'uri' => uri, 'content' => OctriExactJSON.generate(document), 'generated' => true }
    end
  end

  # Stateless synchronous binding. Fiddle borrows input only during the call;
  # every native response is copied and freed before returning to Ruby.
  class Parser
    MAX_REQUEST_BYTES = 128 * 1024 * 1024

    def initialize(library)
      @library = Fiddle.dlopen(File.realpath(library))
      version = function('abi_version', [], Fiddle::TYPE_INT)
      raise LoadError, 'Expected Octri native ABI version 1' unless version.call == 1

      @call = function('call', [Fiddle::TYPE_VOIDP, Fiddle::TYPE_SIZE_T], Fiddle::TYPE_VOIDP)
      @data = function('buffer_data', [Fiddle::TYPE_VOIDP], Fiddle::TYPE_VOIDP)
      @length = function('buffer_len', [Fiddle::TYPE_VOIDP], Fiddle::TYPE_SIZE_T)
      @free = function('buffer_free', [Fiddle::TYPE_VOIDP], Fiddle::TYPE_VOID)
    end

    # Returns the complete Ok/Err transport envelope for parity tooling.
    def call(envelope)
      input = OctriExactJSON.generate(envelope).encode(Encoding::UTF_8)
      raise ArgumentError, 'Binding request exceeds 128 MiB' if input.bytesize > MAX_REQUEST_BYTES

      result = @call.call(Fiddle::Pointer[input], input.bytesize)
      raise NoMemoryError, 'Native parser returned a null buffer' if result.null?

      begin
        OctriExactJSON.parse(@data.call(result).to_s(@length.call(result)).force_encoding(Encoding::UTF_8))
      ensure
        @free.call(result)
      end
    end

    def execute(operation, source, options = {})
      result('abiVersion' => 1, 'action' => 'report',
             'request' => { 'operation' => operation, 'input' => source, 'options' => options })
    end

    def document(operation, source, options = {})
      result('abiVersion' => 1, 'action' => 'document',
             'request' => { 'operation' => operation, 'input' => source, 'options' => options })
    end

    def parse(source, options = {}) = execute('parse', source, options)
    def resolve(source, options = {}) = execute('resolve', source, options)
    def bundle(source, options = {}) = execute('bundle', source, options)
    def dereference(source, options = {}) = execute('dereference', source, options)
    def validate(source, options = {}) = execute('validate', source, options)

    def inspect(source = nil, options = {})
      return super() if source.nil?

      execute('inspect', source, options)
    end

    def analyze(source, options = {}) = execute('analyze', source, options)

    def serialize(document, format: 'json', limits: {})
      encoded = OctriExactJSON.generate(document)
      result('abiVersion' => 1, 'action' => 'serialize', 'document' => encoded, 'format' => format,
             'limits' => limits)
    end

    private

    def result(envelope)
      response = call(envelope)
      raise ParserError, response.fetch('Err') if response.key?('Err')

      response.fetch('Ok')
    end

    def function(name, arguments, result)
      Fiddle::Function.new(@library["octri_parser_#{name}"], arguments, result)
    end
  end
end
