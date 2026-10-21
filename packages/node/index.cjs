// Node 22.19+ can synchronously require ESM without a second parser build.
const api = require("./dist/index.js");
module.exports = Object.assign(api.OpenAPIParser, api);
