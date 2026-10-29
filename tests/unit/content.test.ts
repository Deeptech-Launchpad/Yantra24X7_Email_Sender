import { describe, expect, it } from 'vitest'
import { cleanEmailHtml, composeEmail, fillText, htmlToText, inlineImages, pickTemplate, prepareTemplate } from '../../src/bulk/content.js'
import { extractContacts, firstNameOf, workAddress } from '../../src/bulk/extract.js'
import { fmtLocal, localToUtc, planSequential } from '../../src/bulk/schedule.js'
import { env } from '../../src/config/env.js'

describe('templates', () => {
  it('keeps formatting, removes what could run or load (and says so)', () => {
    const r = cleanEmailHtml('<p style="color:red;background:url(http://x/y.png)" onclick="x()">Hi <b>[First Name]</b> <a href="javascript:alert(1)">x</a> <a href="https://yanthara.example">site</a></p><script>bad()</script><img src="data:image/png;base64,AAAA"><img src="https://cdn.example/logo.png" alt="Logo"><form><input></form>', 'template')
    expect(r.html).toContain('<b>[First Name]</b>')
    expect(r.html).toContain('href="https://yanthara.example"')
    expect(r.html).toContain('src="https://cdn.example/logo.png"')
    expect(r.html).toContain('color:red')
    expect(r.html).not.toMatch(/onclick|javascript:|<script|bad\(\)|data:image|url\(|<form|<input/)
    expect(r.removed).toEqual(expect.arrayContaining(['scripts and active content', 'style rules that load outside content']))
  })

  it('needs a one-line subject and a body with words', () => {
    expect(() => prepareTemplate({ subject: '', bodyHtml: '<p>x</p>' })).toThrow(/Enter the subject/)
    expect(() => prepareTemplate({ subject: 'a\nb', bodyHtml: '<p>x</p>' })).toThrow(/one line/)
    expect(() => prepareTemplate({ subject: 'S', bodyHtml: '<script>x</script>' })).toThrow(/Write or paste the email body/)
    expect(() => prepareTemplate({ subject: 'x'.repeat(201), bodyHtml: '<p>x</p>' })).toThrow(/longer than 200/)
  })

  it('fills only [First Name] and [Company Name], with HTML-escaped values; a blank value is reported, never sent', () => {
    const t = prepareTemplate({ subject: 'For [Company Name]', bodyHtml: '<p>Hi [First Name], about [Company Name] and [Other].</p>' })
    const e = composeEmail({ template: t, firstName: 'Ann', companyName: 'A&B <Tools>' })
    expect(e.subject).toBe('For A&B <Tools>')
    expect(e.html).toContain('Hi Ann, about A&amp;B &lt;Tools&gt; and [Other].')
    expect(e.text).toBe('Hi Ann, about A&B <Tools> and [Other].')
    expect(e.unfilled).toEqual([])
    expect(composeEmail({ template: t, firstName: null, companyName: '' }).unfilled.sort()).toEqual(['[Company Name]', '[First Name]'])
    expect(fillText('[First Name]', { firstName: '  ', companyName: null }).unfilled).toEqual(['[First Name]'])
  })

  it('adds the signature under the email, in HTML and in the plain-text part', () => {
    const t = prepareTemplate({ subject: 'S', bodyHtml: '<p>Body</p>' })
    const e = composeEmail({ template: t, firstName: 'Ann', companyName: 'X', signatureHtml: '<b>Sam Sales</b><br>Yanthara' })
    expect(e.html).toContain('<div><br></div><div><b>Sam Sales</b><br>Yanthara</div>')
    expect(e.text).toBe('Body\n\nSam Sales\nYanthara')
  })

  it('embedded signature pictures become inline images (cid), the same picture once', () => {
    const png = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
    const r = inlineImages(`<img src="${png}"><img src="${png}"><img src="https://x.example/a.png">`)
    expect(r.images).toHaveLength(1)
    expect(r.images[0]!.content.toString()).toBe('png-bytes')
    expect(r.html).toBe('<img src="cid:sig1@yanthara-bulk"><img src="cid:sig1@yanthara-bulk"><img src="https://x.example/a.png">')
  })

  it('plain text keeps paragraphs and lines', () => {
    expect(htmlToText('<p>One</p><p>Two<br>Three</p><ul><li>a</li><li>b</li></ul>')).toBe('One\n\nTwo\nThree\n\na\nb')
  })

  it('templates in turn or at random (repeatable with the same seed)', () => {
    expect([0, 1, 2, 3, 4].map((i) => pickTemplate('sequential', 2, i, 0))).toEqual([0, 1, 0, 1, 0])
    const a = Array.from({ length: 50 }, (_, i) => pickTemplate('random', 3, i, 99))
    expect(Array.from({ length: 50 }, (_, i) => pickTemplate('random', 3, i, 99))).toEqual(a)
    expect(new Set(a).size).toBe(3)
    expect(pickTemplate('random', 1, 5, 99)).toBe(0)
  })
})

describe('time zone', () => {
  it('a date and time in the configured zone become the right instant, also across daylight saving', () => {
    expect(localToUtc('2026-11-03', '10:00', 'Asia/Kolkata')!.toISOString()).toBe('2026-11-03T04:30:00.000Z')
    expect(localToUtc('2026-07-01', '09:00', 'Europe/London')!.toISOString()).toBe('2026-07-01T08:00:00.000Z')
    expect(localToUtc('2026-12-01', '09:00', 'Europe/London')!.toISOString()).toBe('2026-12-01T09:00:00.000Z')
    expect(localToUtc('2026-02-30', '09:00')).toBeNull()
    expect(localToUtc('2026-11-03', '25:00')).toBeNull()
    expect(fmtLocal(new Date('2026-11-03T04:30:00Z'), 'Asia/Kolkata')).toMatch(/Tue, Nov 3, 2026, 10:00 AM GMT\+5:30/)
    expect(planSequential(new Date('2026-11-03T04:30:00Z'), 3, 5).map((d) => d.toISOString())).toEqual(['2026-11-03T04:30:00.000Z', '2026-11-03T04:35:00.000Z', '2026-11-03T04:40:00.000Z'])
  })
})

describe('the Excel rules', () => {
  const H = ['Company Name', 'Contact Person 1', 'Email Id1', 'Contact Person 2', 'Email 2', 'Status']

  it('one email per company: the first named person receives it, colleagues are copied; webmail and "personal" are never used', () => {
    const x = extractContacts([H, ['Acme', 'Ann Lee', 'Primary: ann@acme.example Personal: ann@gmail.com', 'Bob Ray', 'bob@acme.example', ''], ['Acme', 'Cy Fox', 'cy@acme.example', '', '', ''], ['Webby', 'Wil', 'wil@yahoo.com', '', '', '']])
    expect(x.companies[0]!.people.map((p) => p.email)).toEqual(['ann@acme.example', 'bob@acme.example', 'cy@acme.example'])
    expect(x.noAddress).toEqual([{ row: 4, companyName: 'Webby', reason: 'Only a personal / webmail address (not used)' }])
    expect(extractContacts([H, ['Webby', 'Wil', 'wil@yahoo.com', '', '', '']], { allowWebmail: true }).companies[0]!.people[0]!.email).toBe('wil@yahoo.com')
  })

  it('the Status words come from the configuration', () => {
    const rows = [H, ['A', 'Ann', 'ann@a.example', '', '', 'Do not contact'], ['B', 'Bob', 'bob@b.example', '', '', 'outreach done']]
    const before = env.EXCEL_SKIP_STATUS_WORDS
    try {
      env.EXCEL_SKIP_STATUS_WORDS = 'outreach,do not contact'
      const x = extractContacts(rows)
      expect(x.companies.map((c) => c.skip)).toEqual(['Status says "do not contact" (Status: "Do not contact")', 'Already contacted (Status: "outreach done")'])
    } finally {
      env.EXCEL_SKIP_STATUS_WORDS = before
    }
  })

  it('counts an address repeated for the same company as a duplicate; addresses are checked strictly', () => {
    const x = extractContacts([H, ['A', 'Ann', 'ann@a.example', 'Ann', 'ANN@a.example', '']])
    expect(x.duplicates).toEqual([{ row: 2, companyName: 'A', email: 'ann@a.example' }])
    expect(workAddress('not an email').email).toBeNull()
    expect(workAddress('"evil"@x.example, bcc@y.example').email).toBe('bcc@y.example')
    expect(firstNameOf('Mr. john smith')).toBe('John')
    expect(firstNameOf('X')).toBeNull()
  })
})
