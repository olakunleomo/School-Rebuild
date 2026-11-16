# School Portal

Administrators register students, parents and teachers. Teachers enter grades (Continuous Assessment 30 + Exam 70). Parents and students log in to see results. Administrators print result sheets.

## Run it

1. Install Node.js 22.5 or newer (https://nodejs.org). Nothing else to install.
2. In this folder run: `node server.js`
3. Open http://localhost:3000

The first time it runs it creates the administrator login and prints it in the terminal
(also saved in `data/FIRST_ADMIN_LOGIN.txt`; delete that file after you log in).
To choose the password yourself: `ADMIN_PASSWORD=MySecret123 node server.js`

All data lives in one file: `data/school.db`. Copy that file regularly to back up.

## Using it for a different school

Log in as admin, open **School Settings**, change the school name, tagline, logo, colours, address, phone and email (the default is EduPortal in green).
These appear in the header, the login page and every printed result sheet.
To run several schools, use one copy of this folder per school (each has its own `data` folder and its own port: `PORT=3001 node server.js`).

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

## Putting it online

Parents need to reach it from their phones, so host it on a server that runs Node 22.5+ and keeps its disk (for example a small VPS, or a host with a persistent volume). Put it behind HTTPS (Caddy, nginx or the host's built-in HTTPS). Set the `PORT` environment variable if the host asks for it. Back up `data/school.db`.

`node test.js` runs the automatic checks.
