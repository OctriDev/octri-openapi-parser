import { bindingError } from "./errors.js";
import type { Location, Report, SourceDocument } from "./types.js";

type Position = [number | null, number | null, number | null];
type BindingSource = Omit<SourceDocument, "locations"> & {
  locations: Record<string, Position | Location | null>;
};
type BindingReport = Omit<Report, "sources"> & {
  wireVersion?: number;
  sources: BindingSource[];
};

/** Expand binding-only location tables on access. Capture encoded pointers now,
 * so later document mutations cannot change the original location inventory. */
export function restoreReport(report: BindingReport | Report): Report {
  if (!("wireVersion" in report)) return report as Report;
  if (report.wireVersion !== 1)
    throw bindingError(
      "INVALID_TRANSPORT",
      "Unsupported Rust report wire version",
    );
  delete report.wireVersion;
  for (const source of report.sources as BindingSource[]) {
    const positions = source.locations;
    const uri = source.uri;
    let materialized = false;
    let locations: Record<string, Location>;
    const replace = (value: Record<string, Location>) => {
      locations = value;
      materialized = true;
      if (Object.getOwnPropertyDescriptor(source, "locations")?.configurable)
        Object.defineProperty(source, "locations", {
          value,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      return value;
    };
    Object.defineProperty(source, "locations", {
      configurable: true,
      enumerable: true,
      get() {
        if (materialized) return locations;
        return replace(
          Object.fromEntries(
            Object.entries(positions).map(([pointer, position]) => {
              if (position !== null && !Array.isArray(position))
                return [pointer, position];
              const location: Location = { uri, pointer };
              if (position !== null) {
                const [line, column, offset] = position;
                if (line !== null) location.line = line;
                if (column !== null) location.column = column;
                if (offset !== null) location.offset = offset;
              }
              return [pointer, location];
            }),
          ),
        );
      },
      set(value: Record<string, Location>) {
        if (Object.isFrozen(source))
          throw new TypeError("Cannot assign locations on a frozen source");
        replace(value);
      },
    });
  }
  return report as Report;
}
