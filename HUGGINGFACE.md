# Hosting on a Hugging Face Space (free, no card)

One Space = one container = one shared world (unlike Wasmer, which starts several copies).
The Space disk is wiped on restart, so the world is saved in a free Postgres database.

## 1. Free Postgres (Neon, no card)
1. Sign up at https://neon.tech, create a project, and copy the connection details
   (host, database, user, password). Port is 5432.

## 2. Create the Space
1. https://huggingface.co/new-space -> SDK **Docker** (blank), visibility **Public** (free), create.
2. Upload everything in this `server` folder to the Space (Files tab -> Add file -> Upload files, or git push).
   Don't upload node_modules, .next or world-data. The README.md front matter already sets the port to 7860.
3. Space -> Settings -> **Variables and secrets** -> add these as **Secrets**:
   `DB_HOST`, `DB_PORT` (5432), `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`
   (optional: `SEED`, `MAX_PLAYERS`)
4. It builds by itself (a few minutes). When it says Running, open the Space URL: the status page should say
   "saving to database".

## 3. Join
Your Space address is `https://<user>-<space>.hf.space`. Type it in Multiplayer (everyone needs the patched jar).
