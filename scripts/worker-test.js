import Parser, { initialize } from "/packages/browser/dist/index.js";
self.onmessage = async ({ data }) => {
  try {
    if (data.command === "memory") {
      const wasm = await initialize();
      const memoryBytes = [];
      let operations;
      for (let index = 0; index < 8; index++) {
        const report = await Parser.analyze(data.input);
        if (!report.valid) throw new Error("Large Worker validation failed");
        operations = report.inspection.operations.length;
        memoryBytes.push(wasm.memory.buffer.byteLength);
      }
      self.postMessage({ ok: true, operations, memoryBytes });
      return;
    }
    if (data.command === "terminate") {
      await initialize();
      self.postMessage({ started: true });
    }
    self.postMessage({
      ok: true,
      report: await Parser.analyze(data.input, data.options),
    });
  } catch (error) {
    self.postMessage({ ok: false, message: error.message });
  }
};
