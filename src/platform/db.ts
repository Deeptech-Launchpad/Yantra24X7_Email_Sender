import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

// This application's own database (a SQLite file, DATABASE_URL). One client per process.
export const prisma = new PrismaClient()

/** A new id: random, URL- and file-name-safe. */
export const newId = () => randomUUID().replace(/-/g, '')

export const toJson = (v: unknown) => JSON.stringify(v ?? null)

/** Reads a JSON column; a damaged value becomes the fallback rather than an error. */
export function fromJson<T>(v: string | null | undefined, fallback: T): T {
  if (!v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
