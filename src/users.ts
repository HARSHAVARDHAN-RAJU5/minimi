// Users: a simple stand-in for login. Type a name → you are that user (no password).
// The page then sends the user id with every request in the X-User-Id header.
import type { NextFunction, Request, Response } from "express";
import type { Db, User } from "./db.js";

export const MAX_NAME_CHARS = 40;

// Cleans a typed name, or explains what's wrong with it.
export function checkName(raw: unknown): { name: string } | { error: string } {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { error: "Please type a name." };
  if (name.length > MAX_NAME_CHARS) return { error: `Name is too long (max ${MAX_NAME_CHARS} characters).` };
  // Letters and numbers in any language (incl. vowel signs/accents, e.g. Hindi "हर्ष"), plus space - _ .
  if (!/^[\p{L}\p{M}\p{N} ._-]+$/u.test(name)) return { error: "Name can only use letters, numbers, spaces, - _ ." };
  return { name };
}

// Finds the user with this name (any upper/lower case) or creates them.
export function findOrCreateUser(db: Db, name: string): { user: User; created: boolean } {
  const existing = db.findUserByName(name);
  if (existing) return { user: existing, created: false };
  try {
    return { user: db.createUser(name), created: true };
  } catch (err) {
    // Two requests created the same name at once: the other one won, use it.
    const again = db.findUserByName(name);
    if (again) return { user: again, created: false };
    throw err;
  }
}

// Route guard: only lets the request through with a valid X-User-Id; puts the user in res.locals.user.
export function requireUser(db: Db) {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = Number(req.get("X-User-Id"));
    const user = Number.isInteger(id) && id > 0 ? db.getUser(id) : undefined;
    if (!user) {
      res.status(401).json({ error: "Pick a user first." });
      return;
    }
    res.locals.user = user;
    next();
  };
}
