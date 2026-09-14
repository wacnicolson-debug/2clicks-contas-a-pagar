import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // O CLI (migrate, studio, generate) precisa de conexão direta, sem pool.
    url: env("DIRECT_URL"),
  },
});
