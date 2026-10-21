import type * as API from "./dist/index.js" with {
  "resolution-mode": "import",
};
declare const Parser: typeof API.OpenAPIParser & typeof API;
export = Parser;
