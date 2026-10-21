package dev.octri.parser;

import java.io.IOException;
import java.nio.file.Path;

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

  static native int abiVersion();

  static native byte[] call(byte[] input);
}
