"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { sql } = require("drizzle-orm");
const context = new AsyncLocalStorage();
let database;
function getClient() {
  if (!database) {
    const { getDatabase } = require("@netlify/database");
    const { drizzle } = require("drizzle-orm/netlify-db");
    database = drizzle({ client: getDatabase() });
  }
  return context.getStore() || database;
}
function statement(query, params) {
  // Existing portal SQL uses positional question marks; Drizzle binds every value.
  query = query
    .replace(/INSERT OR IGNORE INTO/g, "INSERT INTO")
    .replace(/\bLIKE\b/g, "ILIKE")
    .replace(/COUNT\(\*\)/g, "COUNT(*)::integer");
  const pieces = query.split("?");
  if (pieces.length !== params.length + 1)
    throw new Error("SQL parameter count mismatch");
  const chunks = [];
  pieces.forEach((piece, i) => {
    chunks.push(sql.raw(piece));
    if (i < params.length) chunks.push(sql`${params[i] ?? null}`);
  });
  return sql.join(chunks, sql.raw(""));
}
async function query(text, params) {
  try {
    return await getClient().execute(statement(text, params));
  } catch (error) {
    if (error.cause?.code) throw error.cause;
    throw error;
  }
}
async function all(text, ...params) {
  return (await query(text, params)).rows;
}
async function one(text, ...params) {
  return (await all(text, ...params))[0];
}
async function run(text, ...params) {
  const ignored = text.startsWith("INSERT OR IGNORE");
  if (ignored)
    text =
      text.replace("INSERT OR IGNORE", "INSERT") + " ON CONFLICT DO NOTHING";
  const table = /^INSERT INTO (\w+)/i.exec(text)?.[1];
  if (table && !["settings", "sessions", "login_attempts"].includes(table))
    text += " RETURNING id";
  const result = await query(text, params);
  return {
    lastInsertRowid: result.rows[0]?.id,
    changes: result.rowCount ?? result.affectedRows ?? 0,
  };
}
async function tx(fn, config) {
  if (context.getStore()) return fn();
  return getClient().transaction((client) => context.run(client, fn), config);
}
function setTestDatabase(client) {
  if (process.env.NODE_ENV !== "test")
    throw new Error("Test database injection requires NODE_ENV=test");
  database = client;
}
module.exports = { all, one, run, tx, setTestDatabase };
