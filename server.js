"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = +process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const { all, one, run, tx } = require("./db/client.cjs");
const nv = (v) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "")
    ? null
    : typeof v === "string"
      ? v.trim()
      : v;
class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const needStr = (v, label) => {
  const s = nv(v);
  if (!s) throw bad(label + " is required");
  return String(s);
};
const r2 = (x) => Math.round(x * 100) / 100;
/* ---------- passwords ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString("hex");
async function setPassword(userId, pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  await run(
    "UPDATE users SET salt=?, pw_hash=? WHERE id=?",
    salt,
    hashPw(pw, salt),
    userId,
  );
  await run("DELETE FROM sessions WHERE user_id=?", userId);
}
function checkPassword(u, pw) {
  const a = Buffer.from(hashPw(pw, u.salt), "hex"),
    b = Buffer.from(u.pw_hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genPassword(n = 8) {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
/* ---------- creating users ---------- */
async function createUser(role, refId, wantedUser, wantedPw) {
  let base = slug(wantedUser);
  if (wantedUser && nv(wantedUser)) {
    if (!base)
      throw bad(
        "Username may only use letters, numbers, dot, dash and underscore",
      );
    if (await one("SELECT 1 FROM users WHERE lower(username)=lower(?)", base))
      throw new HttpError(409, `Username "${base}" is already taken`);
  } else {
    base = (await defaultUsername(role, refId)) || `${role}${refId}`;
    let u = base,
      i = 1;
    while (await one("SELECT 1 FROM users WHERE username=?", u)) u = base + ++i;
    base = u;
  }
  const pw = nv(wantedPw) || genPassword();
  if (pw.length < 6) throw bad("Password must be at least 6 characters");
  const info = await run(
    "INSERT INTO users(username,pw_hash,salt,role,ref_id) VALUES(?,?,?,?,?)",
    base,
    "x",
    "x",
    role,
    refId ?? null,
  );
  await setPassword(Number(info.lastInsertRowid), pw);
  return { id: Number(info.lastInsertRowid), username: base, password: pw };
}
async function defaultUsername(role, refId) {
  if (role === "student") {
    const s = await one("SELECT admission_no FROM students WHERE id=?", refId);
    return s && slug(s.admission_no.replace(/\//g, "-"));
  }
  const t =
    role === "parent" ? "parents" : role === "teacher" ? "teachers" : null;
  if (!t) return null;
  const p = await one(`SELECT name FROM ${t} WHERE id=?`, refId);
  return p && slug(p.name.split(/\s+/)[0]) + refId;
}
/* ---------- first run: classes, subjects and an admin account ---------- */
async function firstRun() {
  await tx(async () => {
    await all("SELECT pg_advisory_xact_lock(791236)");
    if (!(await one("SELECT 1 FROM settings WHERE key='seeded'"))) {
      const names = [
        "Nursery 1",
        "Nursery 2",
        "Primary 1",
        "Primary 2",
        "Primary 3",
        "Primary 4",
        "Primary 5",
        "Primary 6",
        "JSS 1",
        "JSS 2",
        "JSS 3",
        "SS 1",
        "SS 2",
        "SS 3",
      ];
      for (const [i, n] of names.entries())
        await run("INSERT INTO classes(name,position) VALUES(?,?)", n, i + 1);
      for (const n of [
        "English Language",
        "Mathematics",
        "Basic Science",
        "Social Studies",
        "Civic Education",
        "Computer Studies",
      ])
        await run("INSERT INTO subjects(name) VALUES(?)", n);
      await run("INSERT INTO settings(key,value) VALUES('seeded','1')");
    }
    if (!(await one("SELECT 1 FROM users WHERE role='admin'"))) {
      if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
        throw new HttpError(
          503,
          "The administrator password needs to be configured before the portal can open.",
        );
      await createUser("admin", null, "admin", process.env.ADMIN_PASSWORD);
    }
  });
}
let initialization;
async function ready() {
  if (!initialization)
    initialization = firstRun().catch((error) => {
      initialization = null;
      throw error;
    });
  return initialization;
}
/* ---------- settings ---------- */
function defaultSession() {
  const d = new Date(),
    y = d.getFullYear();
  return d.getMonth() >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}
const DEFAULTS = {
  schoolName: "EduPortal",
  tagline: "School Portal System",
  logoText: "",
  logoUrl: "",
  primaryColor: "#047857",
  accentColor: "#ff6633",
  address: "",
  phone: "",
  email: "",
  session: defaultSession(),
  term: "1",
};
async function getSettings() {
  const s = { ...DEFAULTS };
  for (const r of await all("SELECT key,value FROM settings"))
    if (r.key in DEFAULTS) s[r.key] = r.value;
  return s;
}
async function saveSettings(b) {
  const out = {};
  for (const k of Object.keys(DEFAULTS))
    if (b[k] !== undefined) out[k] = String(b[k] ?? "").trim();
  if ("schoolName" in out && !out.schoolName)
    throw bad("School name is required");
  if ("session" in out && !/^\d{4}\/\d{4}$/.test(out.session))
    throw bad("Session must look like 2026/2027");
  if ("term" in out && !["1", "2", "3"].includes(out.term))
    throw bad("Term must be 1, 2 or 3");
  for (const c of ["primaryColor", "accentColor"])
    if (c in out && !/^#[0-9a-f]{6}$/i.test(out[c]))
      throw bad("Colours must be like #1e4fd8");
  if (
    out.logoUrl &&
    !/^(https?:\/\/|\/)/i.test(out.logoUrl) &&
    !/^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,/i.test(out.logoUrl)
  )
    throw bad("Logo must be an image link or an uploaded image");
  if (out.logoUrl && out.logoUrl.length > 500000)
    throw bad("Logo image is too large (max about 350 KB)");
  if (out.logoText && out.logoText.length > 3)
    out.logoText = out.logoText.slice(0, 3);
  await tx(async () => {
    for (const [k, v] of Object.entries(out))
      await run(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        k,
        v,
      );
  });
  return await getSettings();
}
/* ---------- routes and helpers ---------- */
const routes = [];
const route = (method, pattern, roles, fn) =>
  routes.push({
    method,
    roles,
    fn,
    re: new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"),
  });
const ADMIN = ["admin"],
  AUTHED = ["*"];

function parseCookies(h) {
  const o = {};
  (h || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0)
      o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
async function sessionUser(req) {
  const tok = parseCookies(req.headers.cookie).sid;
  if (!tok) return null;
  const u = await one(
    `SELECT u.id,u.username,u.role,u.ref_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1`,
    tok,
    Date.now(),
  );
  return u ? { ...u, token: tok } : null;
}
async function displayName(u) {
  if (u.role === "admin") return "School Administrator";
  if (u.role === "student") {
    const s = await one(
      "SELECT first_name,last_name FROM students WHERE id=?",
      u.ref_id,
    );
    return s ? `${s.first_name} ${s.last_name}` : u.username;
  }
  const t = u.role === "parent" ? "parents" : "teachers";
  const p = await one(`SELECT name FROM ${t} WHERE id=?`, u.ref_id);
  return p ? p.name : u.username;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1.5e6) {
        reject(new HttpError(413, "Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(bad("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
const RAW_ROUTES = new Set(["/api/restore"]);
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "That file is too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'",
};
function send(res, status, body, extra = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "Content-Type": isObj
      ? "application/json; charset=utf-8"
      : "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...SEC,
    ...extra,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
async function throttled(key) {
  const attempt = await one("SELECT * FROM login_attempts WHERE key=?", key);
  return (
    attempt &&
    attempt.attempts >= 8 &&
    Date.now() - Number(attempt.window_start) < 15 * 60e3
  );
}
async function noteFail(key) {
  await run(
    "INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=login_attempts.attempts+1",
    key,
    Date.now(),
  );
}
/* ---------- the server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") return send(res, 405, { error: "Not allowed" });
      const file = url.pathname === "/" ? "/index.html" : url.pathname;
      const full = path.normalize(path.join(PUBLIC_DIR, file));
      if (
        !full.startsWith(PUBLIC_DIR) ||
        !fs.existsSync(full) ||
        fs.statSync(full).isDirectory()
      )
        return send(
          res,
          200,
          fs.readFileSync(path.join(PUBLIC_DIR, "index.html")),
        );
      const ext = path.extname(full).toLowerCase();
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
      };
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
        ...SEC,
      });
      return res.end(fs.readFileSync(full));
    }
    await ready();
    let matched = null,
      params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) {
        matched = r;
        params = m.groups || {};
        break;
      }
    }
    if (!matched) return send(res, 404, { error: "Not found" });
    const user = await sessionUser(req);
    if (matched.roles) {
      if (!user) throw new HttpError(401, "Please log in");
      if (!matched.roles.includes("*") && !matched.roles.includes(user.role))
        throw new HttpError(403, "You do not have access to this");
    }
    let body = {},
      raw = null;
    if (req.method !== "GET") {
      if (RAW_ROUTES.has(url.pathname)) raw = await readRaw(req, 100e6);
      else {
        if (
          !(req.headers["content-type"] || "").includes("application/json") &&
          Number(req.headers["content-length"] || 0) > 0
        )
          throw bad("Content-Type must be application/json");
        body = await readBody(req);
      }
    }
    const query = Object.fromEntries(url.searchParams);
    const out = await matched.fn({ user, params, body, query, req, res, raw });
    if (out && out.__send)
      return send(res, out.status || 200, out.body, out.headers);
    send(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (e instanceof HttpError)
      return send(res, e.status, { error: e.message });
    if (e && e.code === "23505")
      return send(res, 409, {
        error: "That admission number, username or name already exists",
      });
    if (e && /UNIQUE constraint failed: students.admission_no/.test(e.message))
      return send(res, 409, { error: "That admission number is already used" });
    if (
      e &&
      /UNIQUE constraint failed: (classes|subjects)\.name/.test(e.message)
    )
      return send(res, 409, { error: "That name already exists" });
    if (e && /UNIQUE constraint failed: users.username/.test(e.message))
      return send(res, 409, { error: "That username is already taken" });
    console.error("Portal request failed:", e.code || e.name);
    if (process.env.NODE_ENV === "test")
      console.error(
        String(e.stack)
          .split("\n")
          .filter((line) => line.trim().startsWith("at "))
          .join("\n"),
      );
    send(res, 500, { error: "Something went wrong on the server" });
  }
});
/* ---------- public + auth routes ---------- */
route("GET", "/api/public", null, async () => await getSettings());
route("POST", "/api/login", null, async ({ body, req }) => {
  const username = String(body.username || "").trim(),
    pw = String(body.password || "");
  const address =
    req.headers["x-nf-client-connection-ip"] || req.socket.remoteAddress || "";
  const key = crypto
    .createHash("sha256")
    .update(address + "|" + username.toLowerCase())
    .digest("hex");
  await run(
    "DELETE FROM login_attempts WHERE window_start<?",
    Date.now() - 15 * 60e3,
  );
  if (await throttled(key))
    throw new HttpError(
      429,
      "Too many attempts. Please wait 15 minutes or ask the administrator.",
    );
  const u = await one(
    "SELECT * FROM users WHERE lower(username)=lower(?)",
    username,
  );
  if (!u || !u.active || !checkPassword(u, pw)) {
    await noteFail(key);
    throw new HttpError(401, "Wrong username or password");
  }
  await run("DELETE FROM login_attempts WHERE key=?", key);
  const token = crypto.randomBytes(32).toString("hex");
  await run("DELETE FROM sessions WHERE expires<?", Date.now());
  await run(
    "INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)",
    token,
    u.id,
    Date.now() + 7 * 864e5,
  );
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return {
    __send: true,
    body: { ok: true },
    headers: {
      "Set-Cookie": `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}${secure}`,
    },
  };
});
route("POST", "/api/logout", null, async ({ user }) => {
  if (user) await run("DELETE FROM sessions WHERE token=?", user.token);
  return {
    __send: true,
    body: { ok: true },
    headers: {
      "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    },
  };
});
route("GET", "/api/me", null, async ({ user }) =>
  user
    ? {
        id: user.id,
        username: user.username,
        role: user.role,
        ref_id: user.ref_id,
        name: await displayName(user),
      }
    : { __send: true, status: 401, body: { error: "Not logged in" } },
);
/* ---------- stats ---------- */
route("GET", "/api/stats", ADMIN, async () => ({
  students: (await one("SELECT COUNT(*) n FROM students WHERE status='active'"))
    .n,
  graduated: (
    await one("SELECT COUNT(*) n FROM students WHERE status='graduated'")
  ).n,
  parents: (await one("SELECT COUNT(*) n FROM parents")).n,
  teachers: (await one("SELECT COUNT(*) n FROM teachers")).n,
  classes: (await one("SELECT COUNT(*) n FROM classes")).n,
  subjects: (await one("SELECT COUNT(*) n FROM subjects")).n,
}));
/* ---------- settings ---------- */
route(
  "PUT",
  "/api/settings",
  ADMIN,
  async ({ body }) => await saveSettings(body),
);

/* ---------- classes and subjects ---------- */
route(
  "GET",
  "/api/classes",
  AUTHED,
  async () =>
    await all(
      "SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id AND s.status='active') AS students FROM classes c ORDER BY position",
    ),
);
route("POST", "/api/classes", ADMIN, async ({ body }) => {
  const name = needStr(body.name, "Class name");
  const pos = ((await one("SELECT MAX(position) m FROM classes")).m || 0) + 1;
  return {
    id: Number(
      (await run("INSERT INTO classes(name,position) VALUES(?,?)", name, pos))
        .lastInsertRowid,
    ),
  };
});
route("PUT", "/api/classes/:id", ADMIN, async ({ params, body }) => {
  await run(
    "UPDATE classes SET name=? WHERE id=?",
    needStr(body.name, "Class name"),
    +params.id,
  );
});
route("POST", "/api/classes/:id/move", ADMIN, async ({ params, body }) => {
  const c = await one("SELECT * FROM classes WHERE id=?", +params.id);
  if (!c) throw new HttpError(404, "Class not found");
  const other =
    body.dir < 0
      ? await one(
          "SELECT * FROM classes WHERE position<? ORDER BY position DESC LIMIT 1",
          c.position,
        )
      : await one(
          "SELECT * FROM classes WHERE position>? ORDER BY position LIMIT 1",
          c.position,
        );
  if (!other) return;
  await tx(async () => {
    await run("UPDATE classes SET position=-1 WHERE id=?", c.id);
    await run("UPDATE classes SET position=? WHERE id=?", c.position, other.id);
    await run("UPDATE classes SET position=? WHERE id=?", other.position, c.id);
  });
});
route("DELETE", "/api/classes/:id", ADMIN, async ({ params }) => {
  if (await one("SELECT 1 FROM students WHERE class_id=?", +params.id))
    throw new HttpError(
      409,
      "Move or promote the students out of this class first",
    );
  if (await one("SELECT 1 FROM grades WHERE class_id=?", +params.id))
    throw new HttpError(
      409,
      "This class has recorded grades and cannot be deleted",
    );
  await run("DELETE FROM classes WHERE id=?", +params.id);
});
route(
  "GET",
  "/api/subjects",
  AUTHED,
  async () => await all("SELECT * FROM subjects ORDER BY name"),
);
route("POST", "/api/subjects", ADMIN, async ({ body }) => ({
  id: Number(
    (
      await run(
        "INSERT INTO subjects(name) VALUES(?)",
        needStr(body.name, "Subject name"),
      )
    ).lastInsertRowid,
  ),
}));
route("PUT", "/api/subjects/:id", ADMIN, async ({ params, body }) => {
  await run(
    "UPDATE subjects SET name=? WHERE id=?",
    needStr(body.name, "Subject name"),
    +params.id,
  );
});
route("DELETE", "/api/subjects/:id", ADMIN, async ({ params }) => {
  if (await one("SELECT 1 FROM grades WHERE subject_id=?", +params.id))
    throw new HttpError(
      409,
      "This subject has recorded grades and cannot be deleted",
    );
  await run("DELETE FROM subjects WHERE id=?", +params.id);
});
route("GET", "/api/sessions", AUTHED, async () => {
  const cur = (await getSettings()).session;
  const list = new Set(
    (await all("SELECT DISTINCT session FROM grades")).map((r) => r.session),
  );
  list.add(cur);
  return [...list].sort().reverse();
});
/* ---------- parents ---------- */
const PARENT_SQL = `SELECT p.*, u.username, u.active AS login_active FROM parents p LEFT JOIN users u ON u.role='parent' AND u.ref_id=p.id`;
route("GET", "/api/parents", ADMIN, async ({ query }) => {
  const l = `%${query.q || ""}%`;
  const rows = await all(
    `${PARENT_SQL} WHERE p.name LIKE ? OR p.phone LIKE ? ORDER BY p.name LIMIT 1000`,
    l,
    l,
  );
  const kids = await all(
    `SELECT s.id,s.parent_id,s.first_name,s.last_name,c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.parent_id IS NOT NULL AND s.status!='withdrawn'`,
  );
  return rows.map((p) => ({
    ...p,
    children: kids.filter((k) => k.parent_id === p.id),
  }));
});
function personFields(b, extra) {
  const f = {
    name: needStr(b.name, "Name"),
    phone: nv(b.phone),
    email: nv(b.email),
    address: nv(b.address),
  };
  for (const k of extra) f[k] = nv(b[k]);
  return f;
}
route(
  "POST",
  "/api/parents",
  ADMIN,
  async ({ body }) =>
    await tx(async () => {
      const f = personFields(body, ["occupation"]);
      const id = Number(
        (
          await run(
            "INSERT INTO parents(name,phone,email,address,occupation) VALUES(?,?,?,?,?)",
            f.name,
            f.phone,
            f.email,
            f.address,
            f.occupation,
          )
        ).lastInsertRowid,
      );
      const credentials =
        body.create_login === false
          ? null
          : await createUser("parent", id, body.username, body.password);
      return { id, credentials };
    }),
);
route("PUT", "/api/parents/:id", ADMIN, async ({ params, body }) => {
  const f = personFields(body, ["occupation"]);
  await run(
    "UPDATE parents SET name=?,phone=?,email=?,address=?,occupation=? WHERE id=?",
    f.name,
    f.phone,
    f.email,
    f.address,
    f.occupation,
    +params.id,
  );
});
route(
  "DELETE",
  "/api/parents/:id",
  ADMIN,
  async ({ params }) =>
    await tx(async () => {
      await run(
        "DELETE FROM users WHERE role='parent' AND ref_id=?",
        +params.id,
      );
      await run("DELETE FROM parents WHERE id=?", +params.id);
    }),
);
/* ---------- teachers ---------- */
const TEACHER_SQL = `SELECT t.*, u.username, u.active AS login_active,
  (SELECT COUNT(*) FROM assignments a WHERE a.teacher_id=t.id) AS assignment_count
  FROM teachers t LEFT JOIN users u ON u.role='teacher' AND u.ref_id=t.id`;
route("GET", "/api/teachers", ADMIN, async ({ query }) => {
  const l = `%${query.q || ""}%`;
  return await all(
    `${TEACHER_SQL} WHERE t.name LIKE ? OR t.phone LIKE ? ORDER BY t.name`,
    l,
    l,
  );
});
async function saveAssignments(teacherId, list) {
  await run("DELETE FROM assignments WHERE teacher_id=?", teacherId);
  for (const a of list || []) {
    const c = +a.class_id,
      s = +a.subject_id;
    if (
      !(await one("SELECT 1 FROM classes WHERE id=?", c)) ||
      !(await one("SELECT 1 FROM subjects WHERE id=?", s))
    )
      throw bad("Invalid class or subject in assignments");
    await run(
      "INSERT OR IGNORE INTO assignments(teacher_id,class_id,subject_id) VALUES(?,?,?)",
      teacherId,
      c,
      s,
    );
  }
}
route(
  "POST",
  "/api/teachers",
  ADMIN,
  async ({ body }) =>
    await tx(async () => {
      const f = personFields(body, ["qualification"]);
      const id = Number(
        (
          await run(
            "INSERT INTO teachers(name,phone,email,address,qualification) VALUES(?,?,?,?,?)",
            f.name,
            f.phone,
            f.email,
            f.address,
            f.qualification,
          )
        ).lastInsertRowid,
      );
      await saveAssignments(id, body.assignments);
      const credentials =
        body.create_login === false
          ? null
          : await createUser("teacher", id, body.username, body.password);
      return { id, credentials };
    }),
);
route(
  "PUT",
  "/api/teachers/:id",
  ADMIN,
  async ({ params, body }) =>
    await tx(async () => {
      const f = personFields(body, ["qualification"]);
      await run(
        "UPDATE teachers SET name=?,phone=?,email=?,address=?,qualification=? WHERE id=?",
        f.name,
        f.phone,
        f.email,
        f.address,
        f.qualification,
        +params.id,
      );
      if (body.assignments) await saveAssignments(+params.id, body.assignments);
    }),
);
route(
  "GET",
  "/api/teachers/:id/assignments",
  ADMIN,
  async ({ params }) =>
    await all(
      "SELECT class_id,subject_id FROM assignments WHERE teacher_id=?",
      +params.id,
    ),
);
route(
  "DELETE",
  "/api/teachers/:id",
  ADMIN,
  async ({ params }) =>
    await tx(async () => {
      await run(
        "DELETE FROM users WHERE role='teacher' AND ref_id=?",
        +params.id,
      );
      await run("DELETE FROM teachers WHERE id=?", +params.id);
    }),
);

/* ---------- create a login for an existing person ---------- */
route("POST", "/api/users", ADMIN, async ({ body }) => {
  const role = body.role;
  if (!["admin", "teacher", "parent", "student"].includes(role))
    throw bad("Invalid role");
  const ref = role === "admin" ? null : +body.ref_id;
  if (role !== "admin") {
    const t = { teacher: "teachers", parent: "parents", student: "students" }[
      role
    ];
    if (!(await one(`SELECT 1 FROM ${t} WHERE id=?`, ref)))
      throw bad("Person not found");
    if (await one("SELECT 1 FROM users WHERE role=? AND ref_id=?", role, ref))
      throw new HttpError(409, "This person already has a login");
  } else if (!nv(body.username))
    throw bad("Username is required for an administrator");
  return await createUser(role, ref, body.username, body.password);
});
/* ---------- students ---------- */
const STUDENT_SQL = `SELECT s.*, c.name AS class_name, p.name AS parent_name, u.username, u.active AS login_active
  FROM students s LEFT JOIN classes c ON c.id=s.class_id LEFT JOIN parents p ON p.id=s.parent_id
  LEFT JOIN users u ON u.role='student' AND u.ref_id=s.id`;
route("GET", "/api/students", ADMIN, async ({ query }) => {
  const w = [],
    p = [];
  if (query.class_id) {
    w.push("s.class_id=?");
    p.push(+query.class_id);
  }
  if (query.status) {
    w.push("s.status=?");
    p.push(query.status);
  }
  if (query.q) {
    w.push(
      "(s.first_name LIKE ? OR s.last_name LIKE ? OR s.admission_no LIKE ?)",
    );
    const l = `%${query.q}%`;
    p.push(l, l, l);
  }
  return await all(
    `${STUDENT_SQL} ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY c.position, s.last_name, s.first_name LIMIT 1000`,
    ...p,
  );
});
route(
  "GET",
  "/api/students/:id",
  ADMIN,
  async ({ params }) =>
    (await one(`${STUDENT_SQL} WHERE s.id=?`, +params.id)) ||
    (() => {
      throw new HttpError(404, "Student not found");
    })(),
);
async function studentFields(b, existing) {
  const f = {
    first_name: needStr(b.first_name ?? existing?.first_name, "First name"),
    last_name: needStr(b.last_name ?? existing?.last_name, "Last name"),
    gender: nv(b.gender ?? existing?.gender),
    dob: nv(b.dob ?? existing?.dob),
    address: nv(b.address ?? existing?.address),
    class_id: +(b.class_id ?? existing?.class_id) || null,
    parent_id:
      b.parent_id === undefined
        ? (existing?.parent_id ?? null)
        : +b.parent_id || null,
    status: b.status ?? existing?.status ?? "active",
  };
  if (
    !f.class_id ||
    !(await one("SELECT 1 FROM classes WHERE id=?", f.class_id))
  )
    throw bad("Choose a class");
  if (
    f.parent_id &&
    !(await one("SELECT 1 FROM parents WHERE id=?", f.parent_id))
  )
    throw bad("Parent not found");
  if (!["active", "graduated", "withdrawn"].includes(f.status))
    throw bad("Invalid status");
  if (f.gender && !["Male", "Female"].includes(f.gender))
    throw bad("Gender must be Male or Female");
  return f;
}
route(
  "POST",
  "/api/students",
  ADMIN,
  async ({ body }) =>
    await tx(async () => {
      const f = await studentFields(body);
      let adm = nv(body.admission_no);
      if (!adm) {
        const y = new Date().getFullYear();
        let n = (await one("SELECT COUNT(*) n FROM students")).n + 1;
        do {
          adm = `STU-${y}-${String(n++).padStart(3, "0")}`;
        } while (await one("SELECT 1 FROM students WHERE admission_no=?", adm));
      }
      const id = Number(
        (
          await run(
            "INSERT INTO students(admission_no,first_name,last_name,gender,dob,address,class_id,parent_id,status) VALUES(?,?,?,?,?,?,?,?,?)",
            adm,
            f.first_name,
            f.last_name,
            f.gender,
            f.dob,
            f.address,
            f.class_id,
            f.parent_id,
            f.status,
          )
        ).lastInsertRowid,
      );
      const credentials =
        body.create_login === false
          ? null
          : await createUser("student", id, body.username, body.password);
      return { id, admission_no: adm, credentials };
    }),
);
route("PUT", "/api/students/:id", ADMIN, async ({ params, body }) => {
  const ex = await one("SELECT * FROM students WHERE id=?", +params.id);
  if (!ex) throw new HttpError(404, "Student not found");
  const f = await studentFields(body, ex);
  const adm = nv(body.admission_no) || ex.admission_no;
  await run(
    "UPDATE students SET admission_no=?,first_name=?,last_name=?,gender=?,dob=?,address=?,class_id=?,parent_id=?,status=? WHERE id=?",
    adm,
    f.first_name,
    f.last_name,
    f.gender,
    f.dob,
    f.address,
    f.class_id,
    f.parent_id,
    f.status,
    ex.id,
  );
});
route(
  "DELETE",
  "/api/students/:id",
  ADMIN,
  async ({ params }) =>
    await tx(async () => {
      await run(
        "DELETE FROM users WHERE role='student' AND ref_id=?",
        +params.id,
      );
      await run("DELETE FROM students WHERE id=?", +params.id);
    }),
);
/* ---------- grade entry (teachers) ---------- */
async function gradeAccess(user, classId, subjectId, term) {
  const st = await getSettings();
  if (![1, 2, 3].includes(term)) throw bad("Choose a term");
  if (user.role === "teacher") {
    if (
      !(await one(
        "SELECT 1 FROM assignments WHERE teacher_id=? AND class_id=? AND subject_id=?",
        user.ref_id,
        classId,
        subjectId,
      ))
    )
      throw new HttpError(
        403,
        "You are not assigned to this class and subject",
      );
    if (term > +st.term)
      throw new HttpError(
        403,
        `Term ${term} has not been opened by the administrator yet`,
      );
  }
  return st;
}
route(
  "GET",
  "/api/my/assignments",
  ["teacher"],
  async ({ user }) =>
    await all(
      `SELECT a.class_id,a.subject_id,c.name AS class_name,s.name AS subject_name FROM assignments a
  JOIN classes c ON c.id=a.class_id JOIN subjects s ON s.id=a.subject_id WHERE a.teacher_id=? ORDER BY c.position,s.name`,
      user.ref_id,
    ),
);
route(
  "GET",
  "/api/gradesheet",
  ["admin", "teacher"],
  async ({ user, query }) => {
    const classId = +query.class_id,
      subjectId = +query.subject_id,
      term = +query.term;
    const st = await gradeAccess(user, classId, subjectId, term);
    const students = await all(
      `SELECT s.id,s.admission_no,s.first_name,s.last_name,g.ca,g.exam FROM students s
    LEFT JOIN grades g ON g.student_id=s.id AND g.subject_id=? AND g.session=? AND g.term=?
    WHERE s.class_id=? AND s.status='active' ORDER BY s.last_name,s.first_name`,
      subjectId,
      st.session,
      term,
      classId,
    );
    return { session: st.session, term, students };
  },
);
route(
  "PUT",
  "/api/gradesheet",
  ["admin", "teacher"],
  async ({ user, body }) => {
    const classId = +body.class_id,
      subjectId = +body.subject_id,
      term = +body.term;
    const st = await gradeAccess(user, classId, subjectId, term);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const parse = (v, max, label, who) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max)
        throw bad(`${label} for ${who} must be a number from 0 to ${max}`);
      return Math.round(n * 100) / 100;
    };
    return await tx(async () => {
      let saved = 0;
      for (const r of rows) {
        const s = await one("SELECT * FROM students WHERE id=?", +r.student_id);
        if (!s || s.class_id !== classId || s.status !== "active")
          throw bad(
            "A student in this list is no longer in the class. Reload the page.",
          );
        const who = `${s.first_name} ${s.last_name}`;
        const ca = parse(r.ca, 30, "Continuous Assessment", who),
          exam = parse(r.exam, 70, "Exam", who);
        if (ca === null && exam === null)
          await run(
            "DELETE FROM grades WHERE student_id=? AND subject_id=? AND session=? AND term=?",
            s.id,
            subjectId,
            st.session,
            term,
          );
        else
          await run(
            `INSERT INTO grades(student_id,class_id,subject_id,session,term,ca,exam) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(student_id,subject_id,session,term) DO UPDATE SET ca=excluded.ca, exam=excluded.exam, class_id=excluded.class_id`,
            s.id,
            classId,
            subjectId,
            st.session,
            term,
            ca,
            exam,
          );
        saved++;
      }
      return { saved };
    });
  },
);
/* ---------- results engine ---------- */
function gradeFor(score) {
  if (score >= 70) return ["A", "Excellent"];
  if (score >= 60) return ["B", "Very Good"];
  if (score >= 50) return ["C", "Good"];
  if (score >= 45) return ["D", "Fair"];
  if (score >= 40) return ["E", "Pass"];
  return ["F", "Fail"];
}
/* rows: one student's grade rows for a session, terms <= T */
function scoreSummary(rows, T) {
  const by = new Map();
  for (const r of rows) {
    if (r.ca == null && r.exam == null) continue;
    if (!by.has(r.subject_id))
      by.set(r.subject_id, { subject: r.subject, t: {} });
    by.get(r.subject_id).t[r.term] = {
      ca: r.ca,
      exam: r.exam,
      total: (r.ca || 0) + (r.exam || 0),
    };
  }
  const subjects = [];
  for (const e of by.values()) {
    if (T < 3) {
      const c = e.t[T];
      if (!c) continue;
      const [grade, remark] = gradeFor(c.total);
      subjects.push({
        subject: e.subject,
        ca: c.ca,
        exam: c.exam,
        total: c.total,
        grade,
        remark,
      });
    } else {
      const present = [1, 2, 3].filter((k) => e.t[k]);
      const cum = present.reduce((a, k) => a + e.t[k].total, 0);
      const avg = r2(cum / present.length);
      const [grade, remark] = gradeFor(avg);
      const c3 = e.t[3];
      subjects.push({
        subject: e.subject,
        t1: e.t[1] ? e.t[1].total : null,
        t2: e.t[2] ? e.t[2].total : null,
        ca: c3 ? c3.ca : null,
        exam: c3 ? c3.exam : null,
        t3: c3 ? c3.total : null,
        cumulative: cum,
        average: avg,
        grade,
        remark,
      });
    }
  }
  subjects.sort((a, b) => a.subject.localeCompare(b.subject));
  const termTotal = subjects.reduce(
    (a, s) => a + (T < 3 ? s.total : s.t3 || 0),
    0,
  );
  const termCount =
    T < 3 ? subjects.length : subjects.filter((s) => s.t3 != null).length;
  const out = {
    subjects,
    termTotal,
    termCount,
    termAvg: termCount ? r2(termTotal / termCount) : 0,
  };
  if (T === 3) {
    out.cumTotal = subjects.reduce((a, s) => a + s.cumulative, 0);
    out.annualAvg = subjects.length
      ? r2(subjects.reduce((a, s) => a + s.average, 0) / subjects.length)
      : 0;
  }
  return out;
}
function rankOf(value, values) {
  return 1 + values.filter((v) => v > value).length;
}

async function buildResult(studentId, session, T) {
  const st = await one(
    `SELECT s.*, c.name AS class_name, p.name AS parent_name FROM students s
                  LEFT JOIN classes c ON c.id=s.class_id LEFT JOIN parents p ON p.id=s.parent_id WHERE s.id=?`,
    studentId,
  );
  if (!st) throw new HttpError(404, "Student not found");
  const SQL = `SELECT g.*, sub.name AS subject FROM grades g JOIN subjects sub ON sub.id=g.subject_id`;
  const own = await all(
    `${SQL} WHERE g.student_id=? AND g.session=? AND g.term<=?`,
    studentId,
    session,
    T,
  );
  const classId = own.length
    ? own.reduce((a, r) => (r.term >= a.term ? r : a)).class_id
    : st.class_id;
  const className =
    ((await one("SELECT name FROM classes WHERE id=?", classId)) || {}).name ||
    st.class_name;
  const peerRows = await all(
    `${SQL} WHERE g.class_id=? AND g.session=? AND g.term<=?`,
    classId,
    session,
    T,
  );
  const peers = new Map();
  for (const r of peerRows) {
    if (!peers.has(r.student_id)) peers.set(r.student_id, []);
    peers.get(r.student_id).push(r);
  }
  if (!peers.has(studentId)) peers.set(studentId, own);
  const sums = new Map(
    [...peers].map(([id, rows]) => [id, scoreSummary(rows, T)]),
  );
  const mine = sums.get(studentId);
  const inTerm = [...sums.values()].filter((s) => s.termCount > 0);
  const result = {
    student: {
      id: st.id,
      admission_no: st.admission_no,
      first_name: st.first_name,
      last_name: st.last_name,
      gender: st.gender,
      dob: st.dob,
      parent_name: st.parent_name,
      status: st.status,
    },
    class_name: className,
    session,
    term: T,
    subjects: mine.subjects,
    summary: {
      subject_count: mine.termCount,
      total: mine.termTotal,
      average: mine.termAvg,
      class_size: inTerm.length,
      position: mine.termCount
        ? rankOf(
            mine.termTotal,
            inTerm.map((s) => s.termTotal),
          )
        : null,
    },
  };
  if (mine.termCount) {
    const [g, rm] = gradeFor(mine.termAvg);
    result.summary.grade = g;
    result.summary.remark = rm;
  }
  if (T === 3) {
    const withAny = [...sums.values()].filter((s) => s.subjects.length > 0);
    const [g, rm] = mine.subjects.length ? gradeFor(mine.annualAvg) : ["", ""];
    result.cumulative = {
      total: mine.cumTotal,
      average: mine.annualAvg,
      grade: g,
      remark: rm,
      class_size: withAny.length,
      position: mine.subjects.length
        ? rankOf(
            mine.annualAvg,
            withAny.map((s) => s.annualAvg),
          )
        : null,
    };
  }
  return result;
}
/* ---------- results routes ---------- */
async function resultAccess(user, studentId) {
  if (user.role === "admin") return;
  if (user.role === "student" && user.ref_id === studentId) return;
  if (user.role === "parent") {
    const s = await one("SELECT parent_id FROM students WHERE id=?", studentId);
    if (s && s.parent_id === user.ref_id) return;
  }
  throw new HttpError(403, "You cannot view these results");
}
async function sessionParam(q) {
  const s = q.session || (await getSettings()).session;
  if (!/^\d{4}\/\d{4}$/.test(s)) throw bad("Invalid session");
  return s;
}
function termParam(q) {
  const t = +q.term;
  if (![1, 2, 3].includes(t)) throw bad("Choose a term");
  return t;
}

route(
  "GET",
  "/api/my/children",
  ["parent"],
  async ({ user }) =>
    await all(
      `SELECT s.id,s.first_name,s.last_name,s.admission_no,c.name AS class_name FROM students s LEFT JOIN classes c ON c.id=s.class_id WHERE s.parent_id=? AND s.status!='withdrawn' ORDER BY s.first_name`,
      user.ref_id,
    ),
);
route("GET", "/api/results/:id", AUTHED, async ({ user, params, query }) => {
  const id = +params.id;
  await resultAccess(user, id);
  return await buildResult(id, await sessionParam(query), termParam(query));
});
route(
  "GET",
  "/api/results/class/:classId",
  ADMIN,
  async ({ params, query }) => {
    const session = await sessionParam(query),
      T = termParam(query);
    const ids = (
      await all(
        "SELECT DISTINCT student_id FROM grades WHERE class_id=? AND session=? AND term<=?",
        +params.classId,
        session,
        T,
      )
    ).map((r) => r.student_id);
    return (
      await Promise.all(
        ids.map(async (id) => await buildResult(id, session, T)),
      )
    ).sort(
      (a, b) =>
        (a.summary.position || 999) - (b.summary.position || 999) ||
        a.student.last_name.localeCompare(b.student.last_name),
    );
  },
);
/* ---------- accounts (only the administrator can change passwords) ---------- */
route(
  "GET",
  "/api/users",
  ADMIN,
  async () =>
    await Promise.all(
      (
        await all(
          "SELECT id,username,role,ref_id,active FROM users ORDER BY role,username",
        )
      ).map(async (u) => ({ ...u, name: await displayName(u) })),
    ),
);
route("POST", "/api/users/:id/reset", ADMIN, async ({ params, body }) => {
  const u = await one("SELECT * FROM users WHERE id=?", +params.id);
  if (!u) throw new HttpError(404, "Account not found");
  const pw = nv(body.password) || genPassword();
  if (pw.length < 6) throw bad("Password must be at least 6 characters");
  await setPassword(u.id, pw);
  return { username: u.username, password: pw };
});
route("PUT", "/api/users/:id", ADMIN, async ({ params, body, user }) => {
  const u = await one("SELECT * FROM users WHERE id=?", +params.id);
  if (!u) throw new HttpError(404, "Account not found");
  if (body.username !== undefined) {
    const nu = slug(body.username);
    if (!nu)
      throw bad(
        "Username may only use letters, numbers, dot, dash and underscore",
      );
    await run("UPDATE users SET username=? WHERE id=?", nu, u.id);
  }
  if (body.active !== undefined) {
    if (u.id === user.id && !body.active)
      throw bad("You cannot deactivate your own account");
    await run(
      "UPDATE users SET active=? WHERE id=?",
      body.active ? 1 : 0,
      u.id,
    );
    if (!body.active) await run("DELETE FROM sessions WHERE user_id=?", u.id);
  }
});
/* ---------- promotion ---------- */
route("POST", "/api/promote", ADMIN, async ({ body }) => {
  const ids = (body.student_ids || []).map(Number).filter(Boolean);
  if (!ids.length) throw bad("Choose at least one student");
  const graduate = !!body.graduate;
  const to = +body.to_class_id;
  if (!graduate && !(await one("SELECT 1 FROM classes WHERE id=?", to)))
    throw bad("Choose the class to promote into");
  return await tx(async () => {
    let n = 0;
    for (const id of ids) {
      const r = graduate
        ? await run(
            "UPDATE students SET status='graduated' WHERE id=? AND status='active'",
            id,
          )
        : await run(
            "UPDATE students SET class_id=? WHERE id=? AND status='active'",
            to,
            id,
          );
      n += Number(r.changes);
    }
    return { moved: n };
  });
});
/* ---------- backup and restore ---------- */
const TABLES = [
  "settings",
  "classes",
  "subjects",
  "parents",
  "teachers",
  "students",
  "assignments",
  "grades",
  "users",
];
async function snapshot(toFile) {
  const data = {};
  await tx(
    async () => {
      for (const t of TABLES) data[t] = await all(`SELECT * FROM ${t}`);
    },
    { isolationLevel: "repeatable read" },
  );
  const file = new DatabaseSync(toFile);
  try {
    file.exec(require("./db/legacy-schema.cjs"));
    for (const t of TABLES)
      for (const row of data[t]) {
        const keys = Object.keys(row);
        file
          .prepare(
            `INSERT INTO ${t} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          )
          .run(...keys.map((k) => row[k]));
      }
  } finally {
    file.close();
  }
}
async function restoreFrom(file) {
  const data = {};
  let chk;
  try {
    chk = new DatabaseSync(file, { readOnly: true });
    if (chk.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw bad("That backup file is damaged");
    if (chk.prepare("PRAGMA foreign_key_check").all().length)
      throw bad("That backup contains inconsistent records");
    for (const t of TABLES) {
      const expected = await all(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position",
        t,
      );
      const actual = chk
        .prepare(`PRAGMA table_info(${t})`)
        .all()
        .map((c) => c.name);
      if (expected.map((c) => c.column_name).join(",") !== actual.join(","))
        throw bad("That backup is from a different portal version");
      data[t] = chk.prepare(`SELECT * FROM ${t}`).all();
    }
    if (!data.users.some((u) => u.role === "admin" && u.active === 1))
      throw bad("That backup has no active administrator");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad("That file is not a School Portal backup");
  } finally {
    if (chk) chk.close();
  }
  await tx(async () => {
    // Block concurrent writes while saving the safety snapshot and restoring.
    await all(
      "LOCK TABLE settings, classes, subjects, parents, teachers, students, assignments, grades, users, sessions IN EXCLUSIVE MODE",
    );
    const before = {};
    for (const t of TABLES) before[t] = await all(`SELECT * FROM ${t}`);
    await run(
      "INSERT INTO backup_snapshots(data) VALUES(?::jsonb)",
      JSON.stringify(before),
    );
    for (const t of ["sessions", ...TABLES.slice().reverse()])
      await run(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      for (const row of data[t]) {
        const keys = Object.keys(row);
        await run(
          `INSERT INTO ${t} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          ...keys.map((k) => row[k]),
        );
      }
      if (t !== "settings")
        await all(
          `SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${t}), 0), 1), (SELECT COUNT(*) > 0 FROM ${t}))`,
        );
    }
  });
}

route("GET", "/api/backup/info", ADMIN, async () => {
  const r = await one("SELECT value FROM settings WHERE key='last_backup'");
  return {
    last_backup: r ? r.value : null,
    students: (await one("SELECT COUNT(*) n FROM students")).n,
    grades: (await one("SELECT COUNT(*) n FROM grades")).n,
  };
});
route("GET", "/api/backup", ADMIN, async () => {
  const dir = fs.mkdtempSync(
    path.join(require("node:os").tmpdir(), "school-export-"),
  );
  const tmp = path.join(dir, "backup.db");
  try {
    await snapshot(tmp);
    const buf = fs.readFileSync(tmp);
    await run(
      "INSERT INTO settings(key,value) VALUES('last_backup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      new Date().toISOString(),
    );
    return {
      __send: true,
      body: buf,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="school-backup-${new Date().toISOString().slice(0, 10)}.db"`,
      },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
route("POST", "/api/restore", ADMIN, async ({ raw }) => {
  if (!raw || raw.length < 100) throw bad("Choose a backup file");
  if (raw.subarray(0, 15).toString("latin1") !== "SQLite format 3")
    throw bad("That file is not a School Portal backup");
  const dir = fs.mkdtempSync(
    path.join(require("node:os").tmpdir(), "school-import-"),
  );
  const tmp = path.join(dir, "upload.db");
  fs.writeFileSync(tmp, raw);
  try {
    await restoreFrom(tmp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return {
    __send: true,
    body: { ok: true },
    headers: {
      "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    },
  };
});
if (require.main === module) {
  server.listen(PORT, () =>
    console.log(`School portal running on http://localhost:${PORT}`),
  );
}
module.exports = { server, ready, buildResult, scoreSummary, gradeFor };
