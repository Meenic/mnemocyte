import { describeLibsqlContract, libsqlStoreInput } from "./libsql.js";

// The other libSQL runs are in libsql-*.test.ts, one per file, so Vitest
// runs them on separate workers.
describeLibsqlContract("libsqlStore", libsqlStoreInput);
