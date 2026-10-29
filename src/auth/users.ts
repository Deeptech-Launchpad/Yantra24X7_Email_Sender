import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'
import { env } from '../config/env.js'
import { newId, prisma } from '../platform/db.js'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../platform/errors.js'

// THE SALES TEAM'S OWN SIGN-IN. Accounts are created by an admin (or, for the
// first admin, with `npm run user:create`). Passwords are stored as bcrypt
// hashes. A session is a signed token (SESSION_SECRET) that expires; the user
// is read again on every request, so a disabled account stops working at once.
//
// Roles: admin  — everything, plus users and every sender account
//        member — campaigns, templates, their own sender accounts
//        viewer — can look, cannot change or send

export type Role = 'admin' | 'member' | 'viewer'
export const ROLES: Role[] = ['admin', 'member', 'viewer']
const ISSUER = 'yanthara-bulk-email'

export interface Principal {
  id: string
  email: string
  name: string
  role: Role
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal
    }
  }
}

const EMAIL = /^[^\s@<>()[\]\\,;:"']+@[^\s@<>()[\]\\,;:"']+\.[A-Za-z]{2,}$/

export function checkPassword(pw: string): void {
  if (pw.length < 10) throw new BadRequestError('The password must be at least 10 characters.')
  if (pw.length > 200) throw new BadRequestError('The password is too long.')
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new BadRequestError('The password must contain letters and digits.')
}

export async function createUser(input: { email: string; name: string; role: Role; password: string }) {
  const email = input.email.trim().toLowerCase()
  if (!EMAIL.test(email)) throw new BadRequestError('Enter a valid email address.')
  const name = input.name.trim()
  if (!name) throw new BadRequestError('Enter the name.')
  if (!ROLES.includes(input.role)) throw new BadRequestError('Unknown role.')
  checkPassword(input.password)
  if (await prisma.user.findUnique({ where: { email } })) throw new ConflictError('A user with this email already exists.')
  const user = await prisma.user.create({
    data: { id: newId(), email, name: name.slice(0, 120), role: input.role, passwordHash: await bcrypt.hash(input.password, 12) },
  })
  return publicUser(user)
}

export const publicUser = (u: { id: string; email: string; name: string; role: string; status: string; createdAt: Date }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role as Role,
  status: u.status,
  createdAt: u.createdAt.toISOString(),
})

// The same work for a wrong email as for a wrong password, so an attacker cannot tell which one was wrong.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-0', 12)

export async function login(emailRaw: string, password: string) {
  const email = String(emailRaw ?? '').trim().toLowerCase()
  const user = await prisma.user.findUnique({ where: { email } })
  const ok = await bcrypt.compare(String(password ?? ''), user?.passwordHash ?? DUMMY_HASH)
  if (!user || !ok) throw new UnauthorizedError('The email or the password is not right.')
  if (user.status !== 'active') throw new ForbiddenError('This account has been disabled. Ask an administrator.')
  const token = jwt.sign({ email: user.email }, env.SESSION_SECRET, { subject: user.id, issuer: ISSUER, expiresIn: env.SESSION_HOURS * 3600, algorithm: 'HS256' })
  return { token, user: publicUser(user) }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedError()
    let sub: string
    try {
      const claims = jwt.verify(header.slice(7), env.SESSION_SECRET, { issuer: ISSUER, algorithms: ['HS256'] }) as jwt.JwtPayload
      sub = String(claims.sub ?? '')
    } catch {
      throw new UnauthorizedError('Your session has expired. Sign in again.')
    }
    const user = await prisma.user.findUnique({ where: { id: sub } })
    if (!user) throw new UnauthorizedError('That account no longer exists. Sign in again.')
    if (user.status !== 'active') throw new ForbiddenError('This account has been disabled. Ask an administrator.')
    req.principal = { id: user.id, email: user.email, name: user.name, role: user.role as Role }
    next()
  } catch (err) {
    next(err)
  }
}

/** Only these roles may continue. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const p = req.principal
    if (!p) return next(new UnauthorizedError())
    if (!roles.includes(p.role)) return next(new ForbiddenError(`This needs the ${roles.join(' or ')} role; you are ${p.role}.`))
    next()
  }

export const canSend = requireRole('admin', 'member')
export const adminOnly = requireRole('admin')

export async function listUsers() {
  const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })
  return users.map(publicUser)
}

export async function updateUser(actor: Principal, id: string, patch: { role?: Role; status?: 'active' | 'disabled'; name?: string; password?: string }) {
  const user = await prisma.user.findUnique({ where: { id } })
  if (!user) throw new NotFoundError('User not found.')
  if (id === actor.id && (patch.status === 'disabled' || (patch.role && patch.role !== 'admin'))) {
    throw new BadRequestError('You cannot disable yourself or remove your own admin role.')
  }
  if (patch.role && !ROLES.includes(patch.role)) throw new BadRequestError('Unknown role.')
  // Never leave the app without an active admin.
  const losingAdmin = user.role === 'admin' && ((patch.role && patch.role !== 'admin') || patch.status === 'disabled')
  if (losingAdmin && (await prisma.user.count({ where: { role: 'admin', status: 'active' } })) <= 1) {
    throw new BadRequestError('At least one active admin must remain.')
  }
  const data: Record<string, unknown> = {}
  if (patch.role) data.role = patch.role
  if (patch.status) data.status = patch.status
  if (patch.name?.trim()) data.name = patch.name.trim().slice(0, 120)
  if (patch.password !== undefined) {
    checkPassword(patch.password)
    data.passwordHash = await bcrypt.hash(patch.password, 12)
  }
  return publicUser(await prisma.user.update({ where: { id }, data }))
}
