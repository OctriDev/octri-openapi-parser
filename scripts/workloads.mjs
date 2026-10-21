/** Deterministic workloads shared by Node, browser and isolation checks. */
export function specification(operations, shape = "shared") {
  const schema = () => ({
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" }, name: { type: "string" } },
  });
  const document = {
    openapi: "3.1.2",
    info: { title: `Workload ${operations} ${shape}`, version: "1" },
    paths: {},
    components: { schemas: {} },
  };
  if (shape === "shared") document.components.schemas.Pet = schema();
  for (let index = 0; index < operations; index++) {
    const name = `Pet${index}`;
    if (shape === "unique") document.components.schemas[name] = schema();
    const responseSchema =
      shape === "inline"
        ? schema()
        : {
            $ref: `#/components/schemas/${shape === "shared" ? "Pet" : name}`,
          };
    document.paths[`/pets/${index}`] = {
      get: {
        operationId: `getPet${index}`,
        responses: {
          200: {
            description: "OK",
            content: { "application/json": { schema: responseSchema } },
          },
        },
      },
    };
  }
  return document;
}

export function externalSpecification(documents = 32) {
  const input = specification(documents);
  const files = {};
  for (let index = 0; index < documents; index++) {
    const name = `model-${index}.json`;
    const schema = { type: "object", properties: { id: { type: "string" } } };
    files[name] = JSON.stringify(schema);
    input.paths[`/pets/${index}`].get.responses[200].content[
      "application/json"
    ].schema = { $ref: name };
  }
  return { input, files };
}

export function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return Object.fromEntries([
    ["medianMs", sorted[Math.floor(sorted.length / 2)]],
    ["p10Ms", sorted[Math.floor(sorted.length * 0.1)]],
    ["p90Ms", sorted[Math.floor(sorted.length * 0.9)]],
    ["runs", sorted.length],
  ]);
}
