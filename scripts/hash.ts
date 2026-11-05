// Print an Argon2id hash for a password: npx tsx scripts/hash.ts <password>
import { hash } from "@node-rs/argon2";
hash(process.argv[2] ?? "bykr-demo-123").then((h) => console.log(h));
