import { randomBytes } from 'node:crypto'
import { createUser, ROLES, type Role } from '../src/auth/users.js'
import { prisma } from '../src/platform/db.js'

// Creates a user from the command line — used for the FIRST admin.
//   npm run user:create -- --email admin@yanthara.example --name "Admin Name" --role admin
// A strong password is generated and shown ONCE (or pass --password to choose one).

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const email = arg('email')
  const name = arg('name')
  const role = (arg('role') ?? 'admin') as Role
  if (!email || !name || !ROLES.includes(role)) {
    console.error('Usage: npm run user:create -- --email <email> --name "<name>" [--role admin|member|viewer] [--password <password>]')
    process.exit(1)
  }
  const password = arg('password') ?? `${randomBytes(12).toString('base64url')}7a`
  const user = await createUser({ email, name, role, password })
  console.log(`Created ${user.role} ${user.email}.`)
  if (!arg('password')) console.log(`Password (shown once — give it to the person and ask them to keep it safe): ${password}`)
}

main()
  .catch((err) => {
    console.error(String((err as Error).message ?? err))
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
