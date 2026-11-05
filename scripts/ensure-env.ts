/**
 * First import of scripts/seed.ts. On a fresh clone there is no .env.local,
 * so create it from .env.example with a freshly generated AUTH_SECRET. An
 * existing .env.local is never touched. Then load it into process.env.
 *
 * This is what lets the README get from clone to running app in four
 * commands: docker compose up, npm install, npm run seed, npm run dev.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { config } from "dotenv";

const LOCAL = ".env.local";
const EXAMPLE = ".env.example";

if (!existsSync(LOCAL) && existsSync(EXAMPLE)) {
  const secret = randomBytes(32).toString("base64");
  const text = readFileSync(EXAMPLE, "utf8").replace(
    /^AUTH_SECRET=.*$/m,
    `AUTH_SECRET=${secret}`,
  );
  writeFileSync(LOCAL, text, { mode: 0o600 });
  console.log(`Created ${LOCAL} from ${EXAMPLE} with a new random AUTH_SECRET`);
}

config({ path: LOCAL });
config();
