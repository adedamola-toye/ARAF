# Run WakeelBoost Work Desk on your own computer

This sets up a private test copy with **synthetic data only** (made-up customers and staff). It
runs entirely on your computer at `http://localhost:3000`; nothing is shared with anyone.

## 1. Install three programs (one time)

| Program | Where to get it | Notes |
|---|---|---|
| **Node.js 22 LTS** | https://nodejs.org (choose "LTS") | Accept the defaults. |
| **Docker Desktop** | https://www.docker.com/products/docker-desktop | Runs the database. Open it once and wait until it says it is running. |
| **Git** (optional) | https://git-scm.com | Only needed if you download with Git instead of a ZIP. |

Optional: **LibreOffice** (https://www.libreoffice.org). Without it, offer letters still generate
as Word files; with it, the app also shows a PDF preview (macOS/Linux, or set `SOFFICE_PATH` on Windows).

## 2. Download the code

**Easiest:** on GitHub open `pmtoje/wakeelboost`, switch the branch to
`claude/new-session-21v5xd`, click **Code → Download ZIP**, and unzip it (for example to your Desktop).

**With Git:**

```
git clone -b claude/new-session-21v5xd https://github.com/pmtoje/wakeelboost.git
```

## 3. Open a terminal in the folder

- **Windows:** open the unzipped folder in File Explorer, click the address bar, type `cmd`, press Enter.
- **macOS:** open Terminal, type `cd ` (with a space), drag the folder onto the window, press Enter.

## 4. Set up (one time, about 2–5 minutes)

Make sure Docker Desktop is running, then type each line and press Enter:

```
docker compose up -d postgres
npm install
npm run setup
```

`npm run setup` creates the settings file and the database, and loads demo staff and requests.

## 5. Start the app (every time you want to use it)

```
npm run dev:all
```

When it says it is ready, open **http://localhost:3000** in your browser. To stop, press `Ctrl + C`
in the terminal. Next time, start Docker Desktop, open the terminal in the folder, and run
`npm run dev:all` again.

## 6. Sign in

1. Enter a demo email (below) and click **Continue**.
2. Open **http://localhost:3000/dev/mailbox** in another tab to read the 6-digit code (the test copy
   does not send real email).
3. Enter the code, choose the workspace, and click **Continue**.

Sessions end after 5 minutes without activity; just sign in again.

| Email | What you can do |
|---|---|
| `superadmin@altbank.ng` | Staff and roles, pricing settings, offer templates (approve for production), audit |
| `rm.ade@altbank.ng` | Relationship Manager: start requests, offer pack, vendor confirmation |
| `anm.south@altbank.ng` | Agent Network Manager with request **WB-2026-001004** at offer preparation |
| `rbe.lagos@altbank.ng` | Business endorsement |
| `co1@altbank.ng`, `co2@altbank.ng`, `co3@altbank.ng` | Credit Officers (assessment, DSR, approvals) |
| `lead1@altbank.ng`, `lead2@altbank.ng` | Credit Leads |
| `unit.head@altbank.ng`, `div.head@altbank.ng` | Unit Head, Divisional Head |
| `do1@altbank.ng`, `do2@altbank.ng` | Disbursement Officers |
| `reports@altbank.ng` | Reports and exports |

All emails end in `@altbank.ng`; the full list is in the README.

## Send real email instead of the test mailbox (optional)

By default the test copy sends no real email; codes appear at `/dev/mailbox`. To deliver real email
through Resend, add a verified domain and key, then follow [docs/EMAIL.md](EMAIL.md). While the domain
is still being verified in Cloudflare, keep `MAIL_DRIVER=dev`.

## Review the offer letters and approve the templates

1. Sign in as `anm.south@altbank.ng`, workspace **Agent Network Manager**.
2. Open **WB-2026-001004** from My Action Queue and click **Generate offer letter**.
3. Open it from the **Documents** tab (Word download, or PDF preview if LibreOffice is installed).
4. Sign in as `superadmin@altbank.ng` → **Offer templates** → **Approve for production** on each template.

## Start again with fresh demo data

```
npm run setup
```

This erases the local test database and reloads the demo data.

## If something goes wrong

| Message | Fix |
|---|---|
| `docker: command not found` / cannot connect to Docker | Open Docker Desktop and wait until it is running, then retry. |
| `Could not reach PostgreSQL` | Run `docker compose up -d postgres`, wait 10 seconds, retry `npm run setup`. |
| Port 5432 already in use | Another PostgreSQL is running; stop it, or change the port in `docker-compose.yml` and `DATABASE_URL` in `.env`. |
| Port 3000 already in use | Close the other program using it, or run `npx next dev -p 3001` and use `http://localhost:3001`. |
| `npm` not found | Reinstall Node.js, then open a new terminal window. |
