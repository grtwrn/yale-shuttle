import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { defaultDbPath, openDb } from "./client.js";

const dbPath = defaultDbPath();
const { db } = openDb(dbPath);
migrate(db, { migrationsFolder: "./drizzle" });
console.log(`migrations applied: ${dbPath}`);
