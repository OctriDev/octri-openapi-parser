package dev.octri.parser;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

final class NativeBridge {
  private static Path loadedLibrary;
  private static Path loadedBridge;

  private NativeBridge() {}

  static synchronized void load(Path library, Path bridge) throws IOException {
    Path nativePath = library.toRealPath();
    Path bridgePath = bridge.toRealPath();
    if (loadedLibrary != null) {
      if (!loadedLibrary.equals(nativePath) || !loadedBridge.equals(bridgePath)) {
        throw new IllegalStateException(
            "One Octri native library pair is supported per JVM class loader");
      }
      return;
    }
    System.load(nativePath.toString());
    System.load(bridgePath.toString());
    if (abiVersion() != 1) throw new LinkageError("Expected Octri native ABI version 1");
    loadedLibrary = nativePath;
    loadedBridge = bridgePath;
  }

  /** Extracts the library pair packaged for this platform and loads it once per class loader. */
  static synchronized void loadBundled() throws IOException {
    if (loadedLibrary != null) return;
    String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
    String arch = System.getProperty("os.arch");
    String platform =
        (os.contains("mac") ? "darwin" : os.contains("linux") ? "linux" : os)
            + "-"
            + (arch.equals("amd64") || arch.equals("x86_64") ? "x64" : arch.equals("aarch64") ? "arm64" : arch);
    String suffix = os.contains("mac") ? ".dylib" : ".so";
    Path directory = Files.createTempDirectory("octri-parser-");
    directory.toFile().deleteOnExit();
    Path library = extract(platform, "liboctri_parser_ffi" + suffix, directory);
    Path bridge = extract(platform, "liboctri_parser_jni" + suffix, directory);
    load(library, bridge);
  }

  private static Path extract(String platform, String name, Path directory) throws IOException {
    String resource = "native/" + platform + "/" + name;
    try (InputStream input = NativeBridge.class.getResourceAsStream(resource)) {
      if (input == null)
        throw new UnsatisfiedLinkError("No bundled Octri native library for " + platform);
      Path target = directory.resolve(name);
      Files.copy(input, target);
      target.toFile().deleteOnExit();
      return target;
    }
  }

  static native int abiVersion();

  static native byte[] call(byte[] input);
}
