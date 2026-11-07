// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "tauri-plugin-ts-webkit",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v15),
  ],
  products: [
    .library(
      name: "tauri-plugin-ts-webkit",
      type: .static,
      targets: ["tauri-plugin-ts-webkit"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ts-webkit",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
