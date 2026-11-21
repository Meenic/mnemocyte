import { describeLibsqlContract, directLibsqlInput } from "./libsql.js";

// The client itself as `store`: detection and the lazily imported backend.
describeLibsqlContract("direct client", directLibsqlInput);
