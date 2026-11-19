import {
  pgTable,
  serial,
  text,
  integer,
  doublePrecision,
  bigint,
  unique,
  uniqueIndex,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export const classes = pgTable("classes", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  position: integer("position").notNull(),
});

export const subjects = pgTable("subjects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
});

export const parents = pgTable("parents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  occupation: text("occupation"),
});

export const teachers = pgTable("teachers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  qualification: text("qualification"),
});

export const students = pgTable("students", {
  id: serial("id").primaryKey(),
  admission_no: text("admission_no").notNull().unique(),
  first_name: text("first_name").notNull(),
  last_name: text("last_name").notNull(),
  gender: text("gender"),
  dob: text("dob"),
  address: text("address"),
  class_id: integer("class_id").references(() => classes.id),
  parent_id: integer("parent_id").references(() => parents.id, {
    onDelete: "set null",
  }),
  status: text("status").notNull().default("active"),
});

export const assignments = pgTable(
  "assignments",
  {
    id: serial("id").primaryKey(),
    teacher_id: integer("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    class_id: integer("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    subject_id: integer("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
  },
  (t) => [unique().on(t.teacher_id, t.class_id, t.subject_id)],
);

export const grades = pgTable(
  "grades",
  {
    id: serial("id").primaryKey(),
    student_id: integer("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    class_id: integer("class_id").notNull(),
    subject_id: integer("subject_id")
      .notNull()
      .references(() => subjects.id),
    session: text("session").notNull(),
    term: integer("term").notNull(),
    ca: doublePrecision("ca"),
    exam: doublePrecision("exam"),
  },
  (t) => [unique().on(t.student_id, t.subject_id, t.session, t.term)],
);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    pw_hash: text("pw_hash").notNull(),
    salt: text("salt").notNull(),
    role: text("role").notNull(),
    ref_id: integer("ref_id"),
    active: integer("active").notNull().default(1),
  },
  (t) => [
    uniqueIndex("users_username_lower_key").on(sql`lower(${t.username})`),
  ],
);

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  user_id: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: bigint("expires", { mode: "number" }).notNull(),
});

export const backupSnapshots = pgTable("backup_snapshots", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  data: jsonb("data").notNull(),
});

export const loginAttempts = pgTable("login_attempts", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  window_start: bigint("window_start", { mode: "number" }).notNull(),
});
