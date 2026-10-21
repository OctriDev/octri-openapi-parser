# Binding dependencies

The project is licensed under Apache-2.0. Root `LICENSE` and
`THIRD_PARTY_NOTICES.md` cover the project and Rust dependencies; this file adds
JVM adapter dependencies.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| Jackson databind | 2.21.7 | Apache-2.0 | https://github.com/FasterXML/jackson-databind |
| Jackson core | 2.21.7 | Apache-2.0 | https://github.com/FasterXML/jackson-core |
| Jackson annotations | 2.21 | Apache-2.0 | https://github.com/FasterXML/jackson-annotations |
| Kotlin standard library | 2.3.21 | Apache-2.0 | https://github.com/JetBrains/kotlin |

Distributed dependency jars retain their upstream `META-INF` license and notice
files. The Java facade uses Jackson JSON trees without enabling polymorphic type
resolution or binding untrusted data to application classes. Python, Ruby, Go,
Swift, Dart and PHP adapters add no third-party runtime dependencies. Their host
standard libraries/runtimes have their own licenses.

Toolchains, formatters and build plugins are development dependencies and are not
included as runtime dependencies. No claim of Android, iOS, Flutter mobile or
Windows qualification follows from the desktop native packages.
