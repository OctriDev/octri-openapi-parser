import type {
  Document,
  Dialect,
  Inspection,
  Location,
  Operation,
  ReferenceEdge,
} from "./types.js";
import { childPointer, object } from "./errors.js";
export interface Lookup {
  get(ref: string): unknown;
  exists(ref: string): boolean;
}
export function resolved(value: unknown, base: string, refs: Lookup): unknown {
  if (object(value) && typeof value.$ref === "string") {
    try {
      return refs.get(new URL(value.$ref, base).href);
    } catch {
      return value;
    }
  }
  return value;
}
const record = (v: unknown): Document => (object(v) ? v : {});
const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export function inspectDocument(
  document: Document,
  dialect: Dialect,
  uri: string,
  refs: Lookup,
  references: ReferenceEdge[],
  location: (uri: string, pointer: string) => Location,
  documentCount: number,
): Inspection {
  const operations: Operation[] = [];
  const methods = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
    ...(dialect === "openapi3.2" ? ["query"] : []),
  ];
  const active = new WeakSet<object>();
  function visitPath(
    path: string,
    raw: unknown,
    pointer: string,
    kind: Operation["kind"],
    parentBase = uri,
  ) {
    const item = record(resolved(raw, parentBase, refs));
    if (active.has(item)) return;
    active.add(item);
    const edge = references.find(
      (e) =>
        e.from.uri === parentBase &&
        e.from.pointer === childPointer(pointer, "$ref"),
    );
    const itemBase = edge?.target?.uri ?? parentBase;
    const itemPointer = edge?.target?.pointer ?? pointer;
    const inherited = array(item.parameters).map((p) =>
      record(resolved(p, itemBase, refs)),
    );
    const entries = methods
      .filter((m) => object(item[m]))
      .map((m) => [m, item[m]] as const);
    if (dialect === "openapi3.2")
      for (const [m, op] of Object.entries(record(item.additionalOperations)))
        entries.push([m, op] as const);
    for (const [method, rawOperation] of entries) {
      const op = record(rawOperation);
      const own = array(op.parameters).map((p) =>
        record(resolved(p, itemBase, refs)),
      );
      const merged = new Map<string, Document>();
      for (const p of [...inherited, ...own])
        merged.set(`${p.in}:${p.name}`, p);
      const opPointer = Object.hasOwn(record(item.additionalOperations), method)
        ? childPointer(
            childPointer(itemPointer, "additionalOperations"),
            method,
          )
        : childPointer(itemPointer, method);
      const responses: Document = {};
      for (const [status, r] of Object.entries(record(op.responses)))
        responses[status] = resolved(r, itemBase, refs);
      const swaggerServers =
        dialect === "swagger2"
          ? (Array.isArray(document.schemes) ? document.schemes : [""]).map(
              (s) => ({
                url:
                  (s ? String(s) + ":" : "") +
                  (document.host ? "//" + document.host : "") +
                  String(document.basePath ?? "/"),
              }),
            )
          : [];
      operations.push({
        method: method.toUpperCase(),
        path,
        kind,
        operationId:
          typeof op.operationId === "string" ? op.operationId : undefined,
        summary: typeof op.summary === "string" ? op.summary : undefined,
        tags: array(op.tags).filter((t): t is string => typeof t === "string"),
        deprecated: op.deprecated === true,
        location: location(itemBase, opPointer),
        parameters: [...merged.values()],
        security: array(op.security ?? document.security),
        servers: array(
          op.servers ?? item.servers ?? document.servers ?? swaggerServers,
        ),
        requestBody: resolved(op.requestBody, itemBase, refs),
        responses,
      });
      for (const [name, callback] of Object.entries(record(op.callbacks))) {
        const cb = record(resolved(callback, itemBase, refs));
        const cbPointer = childPointer(
          childPointer(opPointer, "callbacks"),
          name,
        );
        const cbEdge = references.find(
          (e) =>
            e.from.uri === itemBase &&
            e.from.pointer === childPointer(cbPointer, "$ref"),
        );
        for (const [expression, pathItem] of Object.entries(cb))
          if (!expression.startsWith("x-"))
            visitPath(
              expression,
              pathItem,
              childPointer(cbEdge?.target?.pointer ?? cbPointer, expression),
              "callback",
              cbEdge?.target?.uri ?? itemBase,
            );
      }
    }
    active.delete(item);
  }
  for (const [path, item] of Object.entries(record(document.paths)))
    if (path.startsWith("/"))
      visitPath(path, item, childPointer("/paths", path), "path");
  for (const [name, item] of Object.entries(record(document.webhooks)))
    visitPath(name, item, childPointer("/webhooks", name), "webhook");
  const schemaPointer =
    dialect === "swagger2" ? "/definitions" : "/components/schemas";
  const schemas = Object.entries(
    record(
      dialect === "swagger2"
        ? document.definitions
        : record(document.components).schemas,
    ),
  ).map(([name, schema]) => {
    const pointer = childPointer(schemaPointer, name);
    const targets = new Set([`${uri}#${pointer}`]);
    const used: Location[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of references) {
        if (!edge.target) continue;
        const target = `${edge.target.uri}#${edge.target.pointer}`;
        if (
          [...targets].some(
            (t) => target === t || target.startsWith(t + "/"),
          ) &&
          !used.some(
            (l) => l.uri === edge.from.uri && l.pointer === edge.from.pointer,
          )
        ) {
          used.push(edge.from);
          const parent = edge.from.pointer.replace(/\/\$(dynamicRef|ref)$/, "");
          targets.add(`${edge.from.uri}#${parent}`);
          changed = true;
        }
      }
    }
    return { name, location: location(uri, pointer), schema, usedBy: used };
  });
  return {
    dialect,
    version: String(document.openapi ?? document.swagger),
    info: record(document.info),
    operations,
    schemas,
    securitySchemes: record(
      dialect === "swagger2"
        ? document.securityDefinitions
        : record(document.components).securitySchemes,
    ),
    references,
    statistics: {
      operations: operations.length,
      paths: Object.keys(record(document.paths)).filter((p) =>
        p.startsWith("/"),
      ).length,
      schemas: schemas.length,
      documents: documentCount,
      references: references.length,
      unresolved: references.filter((e) => !e.resolved).length,
    },
  };
}
