import { useState } from 'react'
import { api, type Template } from '../api'
import { canSend, useSession } from '../App'
import { Banner, Html, HtmlEditor, useAction, useLoad, visibleText } from '../ui'

// The team's saved templates. A campaign copies the templates it uses when it is approved,
// so changing a template later never changes what a running campaign sends.

interface Draft {
  id?: string
  name: string
  subject: string
  bodyHtml: string
  key: number
}

export function Templates() {
  const { user } = useSession()
  const list = useLoad(() => api.get<{ templates: Template[] }>('/templates'))
  const act = useAction()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState<{ subject: string; html: string; removed: string[] } | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const may = canSend(user)

  const ready = draft && draft.name.trim() && draft.subject.trim() && visibleText(draft.bodyHtml)
  const edit = (t?: Template) => {
    setSaved(null)
    setPreview(null)
    setDraft(t ? { id: t.id, name: t.name, subject: t.subject, bodyHtml: t.bodyHtml, key: Date.now() } : { name: '', subject: '', bodyHtml: '', key: Date.now() })
  }

  return (
    <>
      <div className="topbar">
        <h1>Templates</h1>
        {may && (
          <button type="button" className="btn primary" onClick={() => edit()}>
            New template
          </button>
        )}
      </div>
      {list.error && <Banner kind="err">{list.error}</Banner>}
      {act.error && <Banner kind="err">{act.error}</Banner>}
      {saved && <Banner kind="ok">{saved}</Banner>}

      {draft && (
        <div className="card accent" aria-label="Template editor">
          <h2>{draft.id ? 'Edit template' : 'New template'}</h2>
          <label className="field">
            Name (only for you and your team)
            <input type="text" maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="field">
            Subject
            <input type="text" maxLength={200} value={draft.subject} placeholder="For example: A proposal for [Company Name]" onChange={(e) => setDraft({ ...draft, subject: e.target.value.replace(/[\r\n]+/g, ' ') })} />
          </label>
          <span className="field" style={{ marginBottom: 4 }}>
            Email body — type, or paste from Gmail, Outlook or Word (formatting is kept)
          </span>
          <HtmlEditor key={draft.key} label="Template body" initialHtml={draft.bodyHtml} onChange={(html) => setDraft((d) => (d ? { ...d, bodyHtml: html } : d))} />
          <p className="note">
            <strong>[First Name]</strong> and <strong>[Company Name]</strong> are filled for each person. Pictures must be links to images on the web.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn"
              disabled={!ready || Boolean(act.busy)}
              onClick={() => void act.run('preview', async () => setPreview(await api.post('/templates/preview', { subject: draft.subject, bodyHtml: draft.bodyHtml })))}
            >
              Preview with sample values
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!ready || Boolean(act.busy)}
              onClick={() =>
                void act.run('save', async () => {
                  const body = { name: draft.name, subject: draft.subject, bodyHtml: draft.bodyHtml }
                  const r = draft.id ? await api.put<{ removed: string[] }>(`/templates/${draft.id}`, body) : await api.post<{ removed: string[] }>('/templates', body)
                  setSaved(`Saved "${draft.name}".${r.removed.length ? ` Taken out for safety: ${r.removed.join('; ')}.` : ''}`)
                  setDraft(null)
                  setPreview(null)
                  list.refresh()
                })
              }
            >
              Save template
            </button>
            <button type="button" className="btn quiet" onClick={() => (setDraft(null), setPreview(null))}>
              Cancel
            </button>
          </div>
          {preview && (
            <div style={{ marginTop: 16 }}>
              <strong>{preview.subject}</strong>
              {preview.removed.length > 0 && <Banner kind="warn">Taken out for safety: {preview.removed.join('; ')}.</Banner>}
              <Html html={preview.html} label="Template preview" />
            </div>
          )}
        </div>
      )}

      {list.data && list.data.templates.length === 0 && !draft && (
        <div className="card">
          <p className="muted">No templates yet.</p>
        </div>
      )}
      {list.data?.templates.map((t) => (
        <div className="card" key={t.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <h3>{t.name}</h3>
              <div className="muted">Subject: {t.subject}</div>
            </div>
            {may && (user.role === 'admin' || t.createdByUserId === user.id) && (
              <div className="row">
                <button type="button" className="btn small" onClick={() => edit(t)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() =>
                    window.confirm(`Delete the template "${t.name}"? Campaigns that used it keep their copy.`) &&
                    void act.run('delete', async () => {
                      await api.del(`/templates/${t.id}`)
                      list.refresh()
                    })
                  }
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  )
}
