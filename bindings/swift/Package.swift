// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "OctriOpenAPIParser",
  platforms: [.macOS(.v13)],
  products: [.library(name: "OctriOpenAPIParser", targets: ["OctriOpenAPIParser"])],
  targets: [
    .systemLibrary(name: "COctri"),
    .target(name: "OctriOpenAPIParser", dependencies: ["COctri"]),
    .executableTarget(
      name: "BindingCheck", dependencies: ["OctriOpenAPIParser"], path: "Tests/BindingCheck"),
    .testTarget(
      name: "JSONValueTests", dependencies: ["OctriOpenAPIParser"], path: "Tests/JSONValueTests"),
  ]
)
