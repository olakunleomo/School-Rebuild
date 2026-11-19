# School Portal

Administrators register students, parents and teachers. Teachers enter grades (Continuous Assessment 30 + Exam 70). Parents and students log in to see results. Administrators print result sheets.

## Run it on Netlify

The frontend is published from `public`, and `netlify/server/index.mjs` serves the portal API. Node.js 24 is required. School records and sessions use Netlify Database (Postgres) through Drizzle; the server does not keep a local live database.

Install dependencies with `npm install`. Set `ADMIN_PASSWORD` securely in Netlify for production and deploy previews before first use (at least 12 characters). The initial administrator username is `admin`. The password is used only when creating the first administrator; later password changes remain in Accounts & Passwords. Credentials are never printed or saved to disk.

Netlify applies the checked-in database migrations during deployment. For local development, use `netlify dev --port 8889` with Netlify's database environment. After changing `db/schema.ts`, generate a migration with `npx drizzle-kit generate --name describe_your_change`.

Existing SQLite backups can be imported from Backup & Restore. Downloads remain SQLite files for compatibility; live records and pre-restore safety snapshots stay in Postgres. Restoring replaces school data and ends all sessions.

## Using it for a different school

Log in as admin, open **School Settings**, change the school name, tagline, logo, colours, address, phone and email (the default is EduPortal in green).
These appear in the header, the login page and every printed result sheet.
To run several schools, deploy a separate Netlify project and database for each school.

## How it works

- **Logins**: every student, parent and teacher gets a username and password when the admin registers them (or later from the Edit screen).
  Only the admin can reset a password (Accounts & Passwords page). Users cannot change their own.
- **Editing**: every record has an Edit button. Fix a mistake in place, no need to delete and re-enter.
- **Terms**: Classes & Sessions holds the current session (for example 2026/2027) and term. Teachers can enter and correct grades for terms up to the current term.
- **Grades**: CA is 0 to 30, Exam is 0 to 70, total 100. A 70-100, B 60-69, C 50-59, D 45-49, E 40-44, F 0-39.
- **Results**: First and Second term sheets show that term only. The Third term sheet also shows each subject's 1st, 2nd and 3rd term totals, the cumulative, the average, and the overall position for the session.
- **Promotion**: Promotion moves chosen students to the next class (or graduates the last class). Untick anyone who repeats. Earlier results stay on their record under the class they were in.
- **Printing**: Results & Printing: choose session, class and term, then print one student or the whole class (one page each).
- **New session**: after Third Term, promote the students, then set the new session and Term 1 in Classes & Sessions.
- Grades of a past session can be corrected by temporarily setting that session and term back in Classes & Sessions.

## Verification

`npm test` runs the portal's HTTP checks against an isolated embedded Postgres test database. It covers role permissions, grade calculations, promotions, account changes, transaction rollback, and SQLite backup/restore compatibility without touching deployed records.
