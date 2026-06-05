import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.SHUTTLE_V2_DB ?? "./store/shuttle-v2.db",
  },
} satisfies Config;
