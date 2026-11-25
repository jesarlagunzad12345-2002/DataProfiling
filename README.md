# ClearSheet — Data Profiling & Excel Cleaning Platform

Phase 1 establishes authentication, a protected dashboard, private Excel workbook upload, worksheet metadata, read-only previews, and upload history. Phase 2 adds saved, read-only data profiling. Phase 3 adds preview-first Word Manipulation. Phase 4 adds manual review, approval, rejection, and an audit trail. Phase 5 adds private Excel exports. Original uploads remain unchanged, and no online company research or enrichment is implemented.

## Requirements

- Node.js 20 or newer and npm
- MySQL 8.0 or compatible
- MySQL Workbench (for database/user setup)

## 1. Create a Workbench connection

1. Open MySQL Workbench and select **+** beside **MySQL Connections**.
2. Set **Connection Name** to `ClearSheet Local` and **Connection Method** to **Standard (TCP/IP)**.
3. Use your MySQL server's hostname (`localhost` for a local server) and port (`3306` by default).
4. Enter **Username** `data_app`.
5. Select **Store in Vault...** on Windows (or **Store in Keychain...** on macOS), enter the password you choose for `data_app`, and confirm. Choose **Test Connection**, then **OK**.

If the `data_app` account does not exist yet, connect to MySQL Workbench as an administrator and run the following SQL. Replace the example password with your own unique, strong password; double embedded single quotes inside the SQL literal. Do not share the password or commit it:

```sql
CREATE USER 'data_app'@'localhost' IDENTIFIED BY 'replace-with-your-own-strong-password';
```

Create the database as an administrator:

```sql
CREATE DATABASE IF NOT EXISTS data_profiling_platform
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
```

Then grant the app access to it:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON data_profiling_platform.* TO 'data_app'@'localhost';
```

If `data_app` already exists and will execute the schema itself, run the grant above as an administrator to add the `REFERENCES` privilege required by the Phase 3 foreign keys. Alternatively, execute the schema as an administrator. If your app connects from another host, adjust the MySQL account host instead of using `'localhost'`. The Workbench vault and the app's `.env` are separate: enter the same `data_app` password in `.env` locally. Never place it in frontend files or source control.

## 2. Create the database and tables

1. In Workbench, connect as a MySQL administrator.
2. Choose **File → Open SQL Script...** and open [`database/schema.sql`](./database/schema.sql).
3. Execute the script, then refresh **SCHEMAS**.
4. Confirm the database `data_profiling_platform` and tables `users`, `uploads`, and `worksheets` exist.

At app startup, `express-mysql-session` creates the `user_sessions` table. Run the current `database/schema.sql` as a MySQL administrator after each database-schema update; it adds missing feature tables without replacing existing data. The application remains available if feature tables are missing, but those features stay disabled until the schema is applied and the app is restarted.

## 3. Configure and run

In PowerShell, from the project folder:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env`; set `DB_PASSWORD` to the password selected for MySQL Workbench (quote the value in `.env` if it contains special characters such as `#`) and replace `SESSION_SECRET` with a random secret. Generate one with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Keep `.env` private; it is ignored by Git. Create your first user (the interactive password prompt does not echo password characters):

```powershell
npm run user:create
```

Enter an email, username, and password (12–72 UTF-8 bytes). Reset a user's password with:

```powershell
npm run user:reset-password
```

Start the app and open [http://localhost:3000](http://localhost:3000):

```powershell
npm start
```

For development auto-restart, use `npm run dev`.

## Phase 1 features

- Email or username login with bcrypt-compatible password hashing, show/hide password, remember-me sessions, logout, login throttling, and an administrator-managed password reset.
- MySQL-backed sessions with an eight-hour sign-in lifetime or a fixed 30-day remember-me lifetime, `httpOnly`/`SameSite` cookies, production-only secure cookies, session regeneration after login, and CSRF validation for state-changing requests.
- Authenticated dashboard and user-owned upload history.
- Private `.xlsx` and legacy `.xls` uploads with extension, MIME, size, and file-signature validation.
- Worksheet names and row/column metadata stored in MySQL; bounded first-10-row/first-20-column previews.
- Responsive navy/royal-blue application shell. Review Changes and Excel Export are available; Reports and Settings remain deferred.

## Phase 2 profiling

1. Apply [`database/schema.sql`](./database/schema.sql) in Workbench before using Data Profiling. Run it as a MySQL administrator. The Phase 2 tables are created with `IF NOT EXISTS`; existing Phase 1 uploads are retained. The server keeps Phase 1 pages available if the tables are missing, while Data Profiling displays a setup-required message. If `data_app` has an access-denied error at runtime, connect as an administrator and run the `GRANT` statement in [Create a Workbench connection](#1-create-a-workbench-connection).
2. Sign in, open **Data Profiling**, choose one of your uploaded worksheets, and confirm the header-row and column mappings.
3. Configure exact-duplicate matching by selecting all columns or a subset. Phone and email duplicates are separately compared when those columns are mapped.
4. Start profiling. Runs are processed in the background; the results page refreshes while queued or processing.
5. Review the saved summary, column completeness, missing-cell highlights, issues, duplicate groups, and suggested standardizations. Suggestions are separate from the original values and are not applied to the workbook.

The profiler streams `.xlsx` worksheet rows and writes results in batches. Legacy `.xls` processing uses whole-workbook parsing and is limited to 10 MB by default; set `PROFILE_XLS_MAX_SIZE_MB` to a numeric value from 1 through 50 to adjust that cap. The process-local background queue allows ten waiting runs; if the server restarts during a run, the run is marked failed and can be started again.

### Phase 2 database tables

| Table | Contents |
| --- | --- |
| `profiling_runs` | User-owned worksheet runs, options, status, and aggregate quality metrics |
| `profiling_columns` | Per-column completeness counts and percentages |
| `profiling_records` | Original row snapshots, missing-cell indexes, issue flags, and separate suggestions |
| `profiling_duplicate_groups` | Exact, normalized phone, or normalized email duplicate groups |
| `profiling_duplicate_members` | Record membership and matching row references for each duplicate group |
| `manipulation_jobs` | User-owned working-copy name and current revision for each upload |
| `manipulation_history` | Submitted operations, user, timestamp, status, and undo relationship |
| `manipulation_cell_changes` | Cell references and original/modified values for every recorded operation |
| `review_changes` | Profiling and word-operation proposals, cell values, source, status, and reviewer |
| `review_audit` | Per-user edits, approvals, and rejections with before/after values and timestamps |
| `excel_exports` | Export owner, source upload, type/filter, stored filename, row/change summary, creation time, and expiration |

Duplicate fingerprints are HMACs scoped to a profiling run; profiling never updates the original upload. Address parsing is deliberately limited to supported, delimited formats and reports ambiguity rather than filling unknown components. Country aliases use a local ISO country dataset and do not call online enrichment services.

## Phase 3 Word Manipulation

1. Apply the current [`database/schema.sql`](./database/schema.sql) in Workbench as a MySQL administrator, then restart the app. It adds `manipulation_jobs`, `manipulation_history`, and `manipulation_cell_changes`.
2. Sign in, open **Word Manipulation**, and select an uploaded worksheet.
3. Select whole columns (multi-select or grid header checkboxes) and/or individual cells in the paginated worksheet grid. Whole-column edits skip the first row by default; select **Include the first row** to include headers. Individual blank cells can be selected for add-text operations.
4. Choose an operation, preview the changed values, then submit or cancel. The preview lists up to 200 changed cells and reports the total; one operation is limited to 250,000 cells, with at most 5,000 individually selected cells.
5. Submitted edits enter manual review. They are not written to the working copy until approved. The original upload is never modified. The tool supports both `.xlsx` and `.xls`; formula and date cells are not edited.
6. Review timestamped operations and cell-level before/after values in **Recent operations** or **Full history**. Fully approved operations can be undone; pending changes can be rejected from **Review Changes**.

Remove/add word operations, find-and-replace, whitespace and special-character cleaning, and upper/lower/proper case are supported. Add operations accept multiple words separated by spaces, commas, or hyphens. Edits are restricted to the selected cells and columns; no operation is submitted until it has been previewed and confirmed.

## Phase 4 Manual Approval and Review

1. Apply the current [`database/schema.sql`](./database/schema.sql) in Workbench using a MySQL administrator account, then restart the app. This creates `review_changes` and `review_audit` and updates the manipulation-history status values. Existing data is retained.
2. Open **Review Changes**, select a workbook, and choose **Sync latest findings** to import the latest completed profiling results. New Word Manipulation submissions appear in the queue automatically.
3. Use status/source filters and search to find proposals. Phone and country standardizations can be approved directly; address components, duplicates, missing values, and invalid-value findings require review. Enter a final cell value for an editable finding before it becomes approvable. Informational findings without a target cell can be rejected but are never written into a workbook.
4. Approve or reject items individually, or select up to 100 items from the same workbook for a confirmed bulk action. Edits, approvals, and rejections remain in the audit history; repeated decisions on completed items are rejected.
5. Only approved cell changes are applied to the user's private working copy. Rejected and pending suggestions are excluded. The uploaded original is never changed.

The review page displays worksheet, Excel row, column/cell, original and proposed values, reason, source operation, status, summary counts, and recent audit events. Access is restricted to the authenticated owner of the uploaded workbook.

## Phase 5 Excel Export

1. Apply the current [`database/schema.sql`](./database/schema.sql) in Workbench as a MySQL administrator, then restart the app. This creates `excel_exports`; the app keeps Excel Export disabled until that table and the Phase 4 review schema are ready.
2. Open **Excel Export**, choose one of your workbooks, and configure the export type. Generated exports can include selected worksheets and columns.
3. **Complete Records** and **Incomplete Records** use the latest completed profiling run for every selected worksheet. Run Data Profiling first if these options report that a profile is missing.
4. **Cleaned Workbook** reads the separate working copy, which contains approved values only. Pending and rejected proposals are never applied. The optional record filter can further limit it to all, complete, or incomplete records.
5. **Original Workbook** creates a byte-for-byte copy of the untouched upload. Worksheet and column selections do not change this exact-copy option.
6. Review the export summary (record totals, completeness counts when available, approved/rejected modification counts, and filename), then choose **Download**. Export files are private and removed automatically after 24 hours; summary history remains available.

Filtered `.xlsx` exports retain worksheet names and preserve cell formatting, number formats, dates, and column widths where supported by ExcelJS. Filtered or cleaned `.xls` exports are converted to `.xlsx`; exact original downloads retain `.xls`. The source upload is never overwritten.

Forgot-password provides account-support guidance; no email service or self-service reset token is configured in this phase.

## Phase 7 Security and performance notes

- Session IDs are regenerated after successful login. Sessions expire after eight hours by default or 30 days when **Remember me** is selected; these are fixed lifetimes rather than sliding expirations.
- Login, uploads, profiling, exports, Word Manipulation, and review mutations are rate-limited per client IP. The current rate-limit store is process-local; use a shared store if deploying multiple app instances.
- Workbook uploads must match the `.xlsx` or `.xls` extension and the corresponding Excel MIME type, then pass binary signature and archive checks. `.xlsx` processing rejects unsafe ZIP paths, oversized entries, more than 20,000 archive entries, and archives expanding beyond 256 MB; shared strings are limited to 32 MB. Legacy `.xls` processing follows the configured `PROFILE_XLS_MAX_SIZE_MB` limit.
- Sensitive files are outside the public static directory, use random server-side names, and require authenticated owner-scoped routes. State-changing forms use CSRF validation; the application does not enable cross-origin access.
- HTTP errors and background profiling failures are logged as structured events without request bodies, passwords, SQL text, or workbook cell values.
- For a remote MySQL server, set `DB_SSL=true` to require verified TLS. If the server uses a private CA, set `DB_SSL_CA` to the CA certificate path. Keep both settings in the private `.env` file.
- Database reads use parameterized values and the schema includes indexes for user-, upload-, status-, and time-scoped access. No new tables are required.
- Fresh databases receive `idx_profile_runs_user_status_source` for latest-run lookups. For an existing database, check `SHOW INDEX FROM profiling_runs`; only if that index is absent, apply `ALTER TABLE profiling_runs ADD INDEX idx_profile_runs_user_status_source (user_id, status, upload_id, worksheet_index, id);`.

The profiling queue remains process-local and serial; it is bounded to prevent unbounded memory growth, but queued work is not durable across restarts. BullMQ/Redis is not configured. For multi-instance production deployments, configure shared session and rate-limit storage and a durable job queue before scaling horizontally. MySQL should use a dedicated least-privilege account, network restrictions, TLS when remote, and regular backups.

### Production deployment checklist

1. Set `NODE_ENV=production`, use HTTPS at the reverse proxy, and set `TRUST_PROXY=true` only when the app is behind a trusted single proxy.
2. Set a unique random `SESSION_SECRET`; store all environment values in the deployment secret manager, not in source control.
3. Use a dedicated MySQL account with only required database privileges. Set `DB_SSL=true` for a remote database and configure `DB_SSL_CA` when the server certificate uses a private CA.
4. Persist `uploads/`, `working-copies/`, and `exports/` on private storage with restrictive filesystem permissions; never expose those directories through the web server.
5. Apply `database/schema.sql` with a database administrator and configure backups and log retention before accepting production data.
6. Run `npm ci`, `npm test`, `npm run build`, and `npm audit` during deployment validation.

## Database tables

| Table | Contents |
| --- | --- |
| `users` | Unique usernames/emails, bcrypt-compatible hashes, and account status |
| `uploads` | Original name, random private storage name, file type/size, and owner |
| `worksheets` | Per-upload worksheet order, names, and row/column counts |
| `user_sessions` | Server-side session data managed by `express-mysql-session` |
| `excel_exports` | User-owned export files, summaries, and expiration timestamps |

Uploaded files are stored under the private `uploads/` directory and are never served as static assets. Word Manipulation and approved review changes use private working copies under `working-copies/`. Generated files are stored privately under `exports/` and are removed after 24 hours.

## Tests and verification

```powershell
npm test
npm run build
```

The automated tests cover workbook parsing, profiling normalization/streaming, templates, and selected security behavior and do not require a live MySQL server. For a complete local smoke test:

1. Run the schema in Workbench; create the `data_app` account and grant privileges.
2. Configure `.env`, then run `npm run user:create` and `npm start`.
3. Visit `/dashboard` in a private browser window; it should redirect to `/login`.
4. Sign in, upload valid `.xlsx` and `.xls` files, and open each worksheet preview.
5. In **Data Profiling**, profile a worksheet with a header row and map its phone, email, address, and country columns if present. Verify summary counts, column completeness, highlighted missing cells, duplicate groups, and suggestions.
6. In **Word Manipulation**, select cells, preview an operation, and submit it. Confirm the working-copy grid stays unchanged until approval.
7. In **Review Changes**, sync profiling findings, edit a proposal, approve one item, bulk-approve and bulk-reject a selection, and reject another item. Verify the approved value appears in the working copy while pending/rejected values do not, and inspect audit activity.
8. In **Excel Export**, download the original and confirm its bytes are unchanged; generate complete, incomplete, and cleaned exports and open each workbook in Excel or ExcelJS. Verify worksheet/column selection, formatting, summaries, ownership checks, and that only approved changes appear in the cleaned file.
9. Confirm each original workbook is unchanged and that another user's account cannot access review items, export records, or files.
10. Check upload/export history and per-user access; sign out and confirm `/dashboard`, `/profiling`, `/word-manipulation`, `/review`, and `/exports` redirect to login.
11. Try an unsupported extension, a file with a renamed extension, and an oversized file; each should be rejected without a history entry.

No uploaded original is overwritten or modified.
