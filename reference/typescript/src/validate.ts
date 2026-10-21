import AjvDraft04 from "ajv-draft-04";
import type { ValidateFunction } from "ajv";
import openapi20 from "../schemas/openapi-2.0.json";
import openapi30 from "../schemas/openapi-3.0.json";
import openapi31 from "../schemas/openapi-3.1.json";
import openapi32 from "../schemas/openapi-3.2.json";
import Ajv2020 from "ajv/dist/2020.js";
import type {
  Diagnostic,
  Document,
  Dialect,
  Inspection,
  Location,
  ParserOptions,
} from "./types.js";
import { childPointer, object } from "./errors.js";
import { visitSyntax } from "./traverse.js";
import { serialize } from "./serialize.js";
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
// Independent TypeScript regression oracle: official document schemas are
// evaluated by Ajv, separately from the production Rust JSON Schema engine.
const structuralOptions = {
  allErrors: true,
  strict: false,
  validateFormats: false,
};
const draft04 = new AjvDraft04(structuralOptions);
const draft2020 = new Ajv2020(structuralOptions);
function documentSchema<T>(schema: T): T {
  // Document structure uses the default Schema Object anchor. Resolve it
  // statically for Ajv; dialect-specific Schema Object validation runs below.
  return JSON.parse(
    JSON.stringify(schema, (_key, value: unknown) => {
      if (!object(value) || value.$dynamicRef !== "#meta") return value;
      const resolved: Record<string, unknown> = {
        ...value,
        $ref: "#/$defs/schema",
      };
      delete resolved.$dynamicRef;
      return resolved;
    }),
  );
}
const structuralValidators: Record<Dialect, ValidateFunction> = {
  swagger2: draft04.compile(openapi20),
  "openapi3.0": draft04.compile(openapi30),
  "openapi3.1": draft2020.compile(documentSchema(openapi31)),
  "openapi3.2": draft2020.compile(documentSchema(openapi32)),
};
const stdDialects = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://spec.openapis.org/oas/3.1/dialect/base",
  "https://spec.openapis.org/oas/3.2/dialect/base",
]);
export function validateDocument(
  doc: Document,
  dialect: Dialect,
  inspection: Inspection,
  options: ParserOptions,
  location: (pointer: string) => Location,
  resolveNode: (value: unknown) => unknown = (value) => value,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (
    code: string,
    message: string,
    pointer: string,
    severity: Diagnostic["severity"] = "error",
  ) =>
    diagnostics.push({ code, message, severity, location: location(pointer) });
  if (options.validate?.schema !== false) {
    const validate = structuralValidators[dialect];
    const serialized = serialize(doc, "json", {
      maxBytes: options.limits?.maxOutputBytes,
    });
    if (!validate(JSON.parse(serialized))) {
      for (const error of validate.errors ?? []) {
        add(
          "SCHEMA_INVALID",
          error.message ?? "Invalid OpenAPI structure",
          error.instancePath,
        );
      }
    }
    if (dialect === "openapi3.1" || dialect === "openapi3.2") {
      visitSyntax(
        doc,
        (schema, p, isSchema) => {
          if (!isSchema) return;
          const meta =
            typeof schema.$schema === "string"
              ? schema.$schema
              : doc.jsonSchemaDialect;
          if (typeof meta === "string" && !stdDialects.has(meta)) {
            add(
              "CUSTOM_DIALECT",
              `Custom schema dialect preserved; vocabulary validation not available: ${meta}`,
              p,
              "warning",
            );
            return;
          }
          const copy = { ...schema };
          if (typeof copy.$schema === "string" && stdDialects.has(copy.$schema))
            delete copy.$schema;
          if (!ajv.validateSchema(copy))
            for (const e of ajv.errors ?? [])
              add(
                "SCHEMA_KEYWORD_INVALID",
                `${e.instancePath} ${e.message}`,
                p + e.instancePath,
              );
        },
        "memory://schema/",
      );
    }
  }
  if (options.validate?.spec !== false) {
    const ids = new Map<string, OperationLocation>();
    for (const op of inspection.operations) {
      const p = op.location.pointer;
      const placeholders = [...op.path.matchAll(/\{([^}]+)\}/g)].map(
        (m) => m[1],
      );
      if (new Set(placeholders).size !== placeholders.length)
        add(
          "DUPLICATE_PATH_PLACEHOLDER",
          "Path template repeats a parameter name",
          p,
        );
      if (op.operationId) {
        const other = ids.get(op.operationId);
        if (other)
          diagnostics.push({
            code: "DUPLICATE_OPERATION_ID",
            severity: "error",
            message: `Duplicate operationId: ${op.operationId}`,
            location: op.location,
            related: [other.location],
          });
        else ids.set(op.operationId, op);
      }
      const declared = new Set<string>();
      for (const param of op.parameters) {
        if (param.in === "path") {
          if (param.required !== true)
            add(
              "PATH_PARAMETER_REQUIRED",
              `Path parameter ${param.name} must have required: true`,
              p,
            );
          declared.add(String(param.name));
          if (!op.path.includes(`{${param.name}}`))
            add(
              "UNUSED_PATH_PARAMETER",
              `Path parameter ${param.name} is not in ${op.path}`,
              p,
            );
        }
      }
      if (op.kind === "path")
        for (const [, name] of op.path.matchAll(/\{([^}]+)\}/g))
          if (!declared.has(name!))
            add(
              "MISSING_PATH_PARAMETER",
              `Path template parameter ${name} is not declared`,
              p,
            );
      for (const req of op.security)
        if (object(req))
          for (const name of Object.keys(req)) {
            if (!Object.hasOwn(inspection.securitySchemes, name))
              add(
                "UNDEFINED_SECURITY_SCHEME",
                `Security scheme ${name} is not defined`,
                p + "/security",
              );
          }
      if (dialect === "swagger2") {
        const bodies = op.parameters.filter((param) => param.in === "body");
        const form = op.parameters.filter((param) => param.in === "formData");
        if (bodies.length > 1)
          add(
            "MULTIPLE_BODY_PARAMETERS",
            "Swagger operations can have at most one body parameter",
            p,
          );
        if (bodies.length && form.length)
          add(
            "BODY_FORM_CONFLICT",
            "Swagger body and formData parameters are mutually exclusive",
            p,
          );
        const rawPath = object(doc.paths) ? doc.paths[op.path] : undefined;
        const rawOperation = object(rawPath)
          ? rawPath[op.method.toLowerCase()]
          : undefined;
        const consumes =
          object(rawOperation) && Array.isArray(rawOperation.consumes)
            ? rawOperation.consumes
            : Array.isArray(doc.consumes)
              ? doc.consumes
              : [];
        for (const param of op.parameters) {
          if (param.type === "array" && !object(param.items))
            add(
              "ARRAY_ITEMS_REQUIRED",
              `Array parameter ${param.name} requires items`,
              p,
            );
          if (
            param.type === "file" &&
            !consumes.some(
              (m) =>
                typeof m === "string" &&
                (/multipart\/(.*\+)?form-data/.test(m) ||
                  /application\/(.*\+)?x-www-form-urlencoded/.test(m)),
            )
          )
            add(
              "FILE_CONSUMES_REQUIRED",
              "File parameters require a form media type",
              p,
            );
          if (param.in === "body")
            checkRequired(resolveNode(param.schema), p + "/parameters");
        }
        for (const [status, res] of Object.entries(op.responses)) {
          if (status.startsWith("x-")) continue;
          if (
            status !== "default" &&
            (!/^\d{3}$/.test(status) ||
              Number(status) < 100 ||
              Number(status) > 599)
          )
            add(
              "INVALID_RESPONSE_STATUS",
              `Invalid HTTP response status ${status}`,
              p + "/responses",
            );
          if (object(res)) {
            if (
              object(res.schema) &&
              res.schema.type === "array" &&
              !object(res.schema.items)
            )
              add(
                "ARRAY_ITEMS_REQUIRED",
                "Array response schema requires items",
                p + "/responses/" + status + "/schema",
              );
            if (object(res.headers))
              for (const [name, raw] of Object.entries(res.headers)) {
                const h = resolveNode(raw);
                if (object(h) && h.type === "array" && !object(h.items))
                  add(
                    "ARRAY_ITEMS_REQUIRED",
                    `Array response header ${name} requires items`,
                    p + "/responses/" + status + "/headers",
                  );
              }
          }
        }
      }
    }
    // Parameter uniqueness must be checked before effective-parameter merging.
    visitSyntax(
      doc,
      (node, p, schema) => {
        if (schema || !Array.isArray(node.parameters)) return;
        const seen = new Set<string>();
        node.parameters.forEach((raw, i) => {
          const v = resolveNode(raw);
          if (!object(v) || v.$ref) return;
          const k = `${v.in}:${v.name}`;
          if (seen.has(k))
            add(
              "DUPLICATE_PARAMETER",
              `Duplicate parameter ${k}`,
              childPointer(childPointer(p, "parameters"), i),
            );
          seen.add(k);
        });
      },
      "memory://schema/",
    );
    if (dialect === "swagger2" && object(doc.definitions))
      for (const [name, schema] of Object.entries(doc.definitions))
        checkRequired(resolveNode(schema), childPointer("/definitions", name));
  }
  return diagnostics;
  function checkRequired(value: unknown, p: string) {
    if (
      !object(value) ||
      value.type !== "object" ||
      !Array.isArray(value.required)
    )
      return;
    const keys = new Set<string>();
    const seen = new WeakSet<object>();
    function collect(raw: unknown) {
      const node = resolveNode(raw);
      if (!object(node) || seen.has(node)) return;
      seen.add(node);
      if (object(node.properties))
        for (const k of Object.keys(node.properties)) keys.add(k);
      if (Array.isArray(node.allOf)) node.allOf.forEach(collect);
    }
    collect(value);
    for (const k of value.required)
      if (typeof k === "string" && !keys.has(k))
        add(
          "UNDECLARED_REQUIRED_PROPERTY",
          `Required property ${k} is not declared`,
          p,
        );
  }
}
interface OperationLocation {
  location: Location;
}
