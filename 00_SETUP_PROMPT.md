# Phase zero — environment setup

Paste everything below the horizontal rule into Claude Code as your **first** message. Do not give it `README-FIRST.md` yet. When this phase finishes you will have a `SETUP-REPORT.md` in the folder; read it, then start the build with a fresh message.

---

You are preparing a development machine. **Do not start building the project in this phase.** Your only job is to get the required software installed and verified, write a short report, and stop.

There is a specification in this folder called `BYKR_ClaudeCode_Prompt.md`. **Do not read it yet.** You will be told when to begin the build.

## Rules for this phase

1. **Check before you install.** Several of these may already be present. Report the version you find and move on rather than reinstalling.
2. **Ask before anything that needs administrator rights, a password, or a graphical installer.** Tell me exactly what you want to run and why, then wait. Do not run a command with `sudo` without asking first.
3. **Do not modify anything outside this folder** except through a package manager installing the software listed below.
4. **Do not disable transport security verification**, do not add insecure package registry flags, and do not pipe a script from the internet straight into a shell without first showing me the URL and asking.
5. If an installation fails, stop and report it. Do not work around it with an unofficial build or a third-party mirror.

## Step 1 — Report the environment first

Before installing anything, run the checks and give me a single table with what you found.

- Operating system name and version, and processor architecture
- Whether this is Windows Subsystem for Linux, and which distribution if so
- Whether you have administrator or `sudo` rights
- Which package manager is available: Homebrew, apt, dnf, winget, Chocolatey
- Free disk space on the volume holding this folder
- Installed versions, or absent, for each of: `node`, `npm`, `git`, `docker`, `docker compose`, `psql`, `mongosh`

Then tell me what you intend to install and wait for me to confirm before proceeding to step 2.

## Step 2 — Install what is missing

| Software | Minimum version | Purpose |
|---|---|---|
| Node.js | 20 LTS or newer | Runs Next.js and every build script |
| npm | Ships with Node.js | Package installation |
| Git | Any current version | Version control, graded by the rubric |
| Docker Engine with the Compose plugin | Any current version | Runs both databases as containers |
| PostgreSQL client (`psql`) | 16 | Applying SQL files and inspecting the database by hand |
| MongoDB Shell (`mongosh`) | 2.x | Inspecting collections and indexes by hand |

Note that the PostgreSQL and MongoDB **servers** are not installed natively. They run as Docker containers. Only the two command line clients are installed on the machine.

Install using the platform's normal package manager:

- **macOS** — Homebrew. `brew install node git postgresql@16 mongosh`. Docker Desktop is a graphical installer from docker.com and cannot be installed unattended; if it is absent, stop and tell me, and I will install it myself before you continue.
- **Debian or Ubuntu, including Windows Subsystem for Linux** — Node.js from NodeSource, Docker Engine from Docker's official apt repository, `postgresql-client-16` from the PostgreSQL apt repository, and `mongodb-mongosh` from the MongoDB apt repository. Show me each repository you intend to add before adding it.
- **Fedora or Red Hat** — dnf, with the equivalent official repositories.
- **Windows without Windows Subsystem for Linux** — stop and tell me. This project is substantially easier under Windows Subsystem for Linux with Ubuntu, and I would rather set that up than fight native Windows paths.

## Step 3 — Pull and smoke test the database images

Pull both images:

- `pgvector/pgvector:pg16` — PostgreSQL 16 with the pgvector extension already compiled in. Use this image rather than the plain `postgres:16` image; installing pgvector into the plain image by hand is avoidable work.
- `mongo:7`

Then run a throwaway smoke test on each, and remove the test containers afterwards. **Do not create `docker-compose.yml` in this phase** — the build specification creates it as its own first step, and I do not want two competing versions of that file.

PostgreSQL smoke test — it must prove three things:

1. The container starts and accepts a connection from `psql` on the host.
2. `CREATE EXTENSION vector;` succeeds.
3. A table with a `vector(3)` column can be created, a row inserted, and a nearest-neighbour query using the `<=>` operator returns a result.

That third check matters. A container that starts is not proof that pgvector works, and finding out it does not work at step 7 of the build rather than now costs hours.

MongoDB smoke test — it must prove three things:

1. The container starts and accepts a connection from `mongosh` on the host.
2. A document carrying a GeoJSON `Point` can be inserted.
3. A `2dsphere` index can be created on that field and a `$near` query returns the document.

Remove both test containers and their volumes when the checks pass.

## Step 4 — Verify the Node.js toolchain

In a temporary directory outside this folder, confirm that `npx create-next-app@latest` can scaffold a TypeScript project without error, then delete it. This proves network access to the npm registry and that the Node.js version is new enough for Next.js 15. Do not scaffold into this folder — the build specification has its own layout and I do not want a default scaffold fighting it.

## Step 5 — Write the report and stop

Create `SETUP-REPORT.md` in this folder containing:

- The environment table from step 1, updated with final installed versions
- One row per smoke test with its result and the actual output of the vector query and the `$near` query
- Anything you could not install, with the reason and what I need to do by hand
- The exact commands you ran that required administrator rights

Then stop and tell me the setup is complete. **Do not read `README-FIRST.md`, do not read `BYKR_ClaudeCode_Prompt.md`, and do not begin the build.** I will start the next phase myself.
