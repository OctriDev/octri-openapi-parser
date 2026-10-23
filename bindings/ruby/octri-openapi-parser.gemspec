# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name = 'octri-openapi-parser'
  spec.version = '0.1.2'
  spec.summary = 'Ruby bindings for the Octri Rust OpenAPI parser'
  spec.description = 'Validate, parse, bundle and dereference Swagger 2.0 and OpenAPI 3.x documents ' \
                     'with the bundled Octri Rust parser.'
  spec.authors = ['Octri contributors']
  spec.license = 'Apache-2.0'
  spec.homepage = 'https://github.com/octridev/octri-openapi-parser'
  spec.required_ruby_version = '>= 3.1'
  spec.files = Dir['lib/**/*.rb', 'lib/octri_parser/native/*']
  spec.require_paths = ['lib']
  # Bundled rather than default gems from Ruby 3.4 (bigdecimal) and 4.0 (fiddle).
  spec.add_dependency 'bigdecimal'
  spec.add_dependency 'fiddle'
  spec.metadata['rubygems_mfa_required'] = 'true'
end
