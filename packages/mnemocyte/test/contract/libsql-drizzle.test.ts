import { drizzle } from "drizzle-orm/libsql";
import { describeLibsqlContract } from "./libsql.js";

// A Drizzle instance over the client: Mnemocyte runs on its `$client`.
describeLibsqlContract("Drizzle", (client) => drizzle({ client }));
