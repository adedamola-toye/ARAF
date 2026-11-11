# Run WakeelBoost Work Desk on your own computer

This sets up a private test copy with **synthetic data only** (made-up customers and staff). It
runs entirely on your computer at `http://localhost:3000`; nothing is shared with anyone.

## 1. Install three programs (one time)

| Program | Where to get it | Notes |
|---|---|---|
| **Node.js 22 LTS** | https://nodejs.org (choose "LTS") | Accept the defaults. |
| **PostgreSQL 16** | https://www.postgresql.org/download | Runs the database. Create the `wakeel_dev` database during install, or use a Supabase project and its connection string. |
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

Make sure PostgreSQL is running (or put your Supabase connection string in `.env`), then type each
line and press Enter:

```
npm install
npm run setup
```

`npm run setup` creates the settings file and the database, and loads demo staff and requests. If
your database credentials differ from the defaults, edit `DATABASE_URL` in `.env` first.

## 5. Start the app (every time you want to use it)

```
npm run dev:all
```

When it says it is ready, open **http://localhost:3000** in your browser. To stop, press `Ctrl + C`
in the terminal. Next time, make sure PostgreSQL is running, open the terminal in the folder, and
run `npm run dev:all` again.

## 6. Sign in

1. Enter a seeded email (below) and click **Continue**.
2. Check that email inbox for the 6-digit code. Codes are sent through Resend.
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

## Email delivery

Sign-in codes and notifications are sent through Resend using the verified `wakeelboost.ng` domain.
Set `RESEND_API_KEY` and keep `MAIL_DRIVER=resend`; see [docs/EMAIL.md](EMAIL.md) for details.

To send a test message:

```
npm run mail:test -- you@example.com
```

## Review the offer letters and approve the templates

1. Sign in as `anm.south@altbank.ng`, workspace **Agent Network Manager**.
2. Open **WB-2026-001004** from My Action Queue and click **Generate offer letter**.
3. Open it from the **Documents** tab (Word download, or PDF preview if LibreOffice is installed).
4. Sign in as `superadmin@altbank.ng` → **Offer templates** → **Approve for production** on each template.

## Upload the bank directory

The bank directory is the list of staff email addresses that new users and closure recipient groups
are checked against.

1. Sign in as `superadmin@altbank.ng` and open **Administration → Bank directory**.
2. Click **Download template (CSV)**, or use the bank's own staff export. The file needs **Email**
   and **Full name** columns; **Department**, **Group mailbox** (Yes/No) and **Active** (Yes/No) are
   optional. Excel (.xlsx) or .csv, `@altbank.ng` addresses only.
3. Choose the file and how to import:
   - **Add and update**: adds new people and updates existing ones; nobody is removed.
   - **Full replace**: the file is the complete list; anyone missing is marked inactive (not deleted).
4. Click **Preview changes**, check the counts and any row errors, then click **Import**.

## Start again with fresh demo data

```
npm run setup
```

This erases the local test database and reloads the demo data.

## If something goes wrong

| Message | Fix |
|---|---|
| `Could not reach PostgreSQL` | Start PostgreSQL, wait 10 seconds, then retry `npm run setup`. Check `DATABASE_URL` in `.env`. |
| Port 5432 already in use | Another PostgreSQL is running; stop it, or change the port in `DATABASE_URL` in `.env`. |
| Port 3000 already in use | Close the other program using it, or run `npx next dev -p 3001` and use `http://localhost:3001`. |
| `npm` not found | Reinstall Node.js, then open a new terminal window. |
