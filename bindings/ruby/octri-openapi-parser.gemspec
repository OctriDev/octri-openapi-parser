# frozen_string_literal: true

Gem::Specification.new do |spec|
  spec.name = 'octri-openapi-parser'
  spec.version = '0.1.0'
  spec.summary = 'Ruby bindings for the Octri Rust OpenAPI parser'
  spec.authors = ['Octri contributors']
  spec.homepage = 'https://github.com/octridev/octri-openapi-parser'
  spec.required_ruby_version = '>= 3.1'
  spec.files = Dir['lib/**/*.rb']
  spec.require_paths = ['lib']
  spec.metadata['allowed_push_host'] = 'https://publication-disabled.invalid'
  spec.metadata['rubygems_mfa_required'] = 'true'
end
