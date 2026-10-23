// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "OctriOpenAPIParser",
  platforms: [.macOS(.v13)],
  products: [.library(name: "OctriOpenAPIParser", targets: ["OctriOpenAPIParser"])],
  targets: [
    // Release builds place each platform's native library under native/.
    .target(name: "OctriOpenAPIParser", resources: [.copy("native")]),
    .executableTarget(
      name: "BindingCheck", dependencies: ["OctriOpenAPIParser"], path: "Tests/BindingCheck"),
    .testTarget(
      name: "JSONValueTests", dependencies: ["OctriOpenAPIParser"], path: "Tests/JSONValueTests"),
  ]
)
