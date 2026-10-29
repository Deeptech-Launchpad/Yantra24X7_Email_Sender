import { newId, prisma } from '../platform/db.js'
import { ForbiddenError, NotFoundError, BadRequestError } from '../platform/errors.js'
import { audit } from '../platform/log.js'
import type { Principal } from '../auth/users.js'
import { composeEmail, prepareTemplate } from './content.js'

// SAVED TEMPLATES: the team's own emails (subject + body), cleaned when saved.
// A campaign copies the templates it uses at approval, so editing a template
// later never changes what a running campaign sends.

const view = (t: { id: string; name: string; subject: string; bodyHtml: string; createdByUserId: string; createdAt: Date; updatedAt: Date }) => ({
  id: t.id,
  name: t.name,
  subject: t.subject,
  bodyHtml: t.bodyHtml,
  createdByUserId: t.createdByUserId,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
})

export async function listTemplates() {
  const rows = await prisma.template.findMany({ where: { archived: false }, orderBy: { updatedAt: 'desc' } })
  return rows.map(view)
}

export async function getTemplate(id: string) {
  const t = await prisma.template.findFirst({ where: { id, archived: false } })
  if (!t) throw new NotFoundError('Template not found.')
  return t
}

function checkName(name: string) {
  const n = String(name ?? '').trim()
  if (!n) throw new BadRequestError('Give the template a name.')
  return n.slice(0, 100)
}

export async function saveTemplate(user: Principal, input: { id?: string; name: string; subject: string; bodyHtml: string }) {
  const name = checkName(input.name)
  const t = prepareTemplate({ subject: input.subject, bodyHtml: input.bodyHtml })
  let row
  if (input.id) {
    const old = await getTemplate(input.id)
    if (user.role !== 'admin' && old.createdByUserId !== user.id) throw new ForbiddenError('Only the person who wrote this template, or an admin, can change it.')
    row = await prisma.template.update({ where: { id: old.id }, data: { name, subject: t.subject, bodyHtml: t.html } })
  } else {
    row = await prisma.template.create({ data: { id: newId(), name, subject: t.subject, bodyHtml: t.html, createdByUserId: user.id } })
  }
  await audit({ userId: user.id, action: input.id ? 'template.updated' : 'template.created', summary: `Template "${name}" saved` })
  return { ...view(row), removed: t.removed }
}

export async function archiveTemplate(user: Principal, id: string) {
  const old = await getTemplate(id)
  if (user.role !== 'admin' && old.createdByUserId !== user.id) throw new ForbiddenError('Only the person who wrote this template, or an admin, can delete it.')
  await prisma.template.update({ where: { id }, data: { archived: true } })
  await audit({ userId: user.id, action: 'template.deleted', summary: `Template "${old.name}" deleted` })
  return { id, deleted: true }
}

/** A template filled with sample values, to see it before using it. Nothing is stored. */
export function previewTemplate(input: { subject: string; bodyHtml: string; firstName?: string; companyName?: string }) {
  const t = prepareTemplate(input)
  const email = composeEmail({ template: t, firstName: input.firstName || 'Priya', companyName: input.companyName || 'Example Industries' })
  return { subject: email.subject, html: email.html, text: email.text, removed: t.removed }
}
