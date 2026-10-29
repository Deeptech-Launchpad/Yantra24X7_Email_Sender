import ExcelJS from 'exceljs'
import { BadRequestError } from '../platform/errors.js'

// THE UPLOADED SPREADSHEET, AS ROWS OF TEXT (adapted from the Marketing AI Agent's Bulk Email, 2026-10-29).
//
// One worksheet of an .xlsx file — the one chosen, or else the first that has an email
// heading (a workbook often starts with a summary sheet) — each cell as the text Excel shows.
// Nothing in the file is executed: formulas are read as their stored result.

/** Bigger than any contact list this is for; refused rather than read. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
export const MAX_ROWS = 5000

export interface Spreadsheet {
  rows: string[][]
  /** Every worksheet of the workbook, in order. */
  sheets: string[]
  /** The one read. */
  sheet: string
}

export async function readSpreadsheet(buffer: Buffer, sheetName?: string): Promise<Spreadsheet> {
  if (buffer.length === 0) throw new BadRequestError('The file is empty.')
  if (buffer.length > MAX_UPLOAD_BYTES) throw new BadRequestError('The file is larger than 5 MB.')
  // An .xlsx file is a zip archive: it starts "PK".
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new BadRequestError('This is not an .xlsx file. In Excel, use File → Save As → Excel Workbook (.xlsx).')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  } catch (err) {
    throw new BadRequestError(`The file could not be read as an Excel workbook: ${(err as Error).message}`)
  }
  const sheets = wb.worksheets.map((w) => w.name)
  if (!sheets.length) throw new BadRequestError('The workbook has no worksheet.')
  let sheet: ExcelJS.Worksheet | undefined
  if (sheetName) {
    sheet = wb.worksheets.find((w) => w.name === sheetName)
    if (!sheet) throw new BadRequestError(`The workbook has no sheet named "${sheetName.slice(0, 100)}".`)
  } else {
    sheet = wb.worksheets.find((w) => rowsOf(w, 30).some((r) => r.some((c) => /^\s*e-?mail\b|\bmail id\b/i.test(c)))) ?? wb.worksheets[0]!
  }
  const rows = rowsOf(sheet, MAX_ROWS + 2)
  if (rows.length > MAX_ROWS + 1) throw new BadRequestError(`The sheet "${sheet.name}" has more than ${MAX_ROWS} rows.`)
  return { rows, sheets, sheet: sheet.name }
}

/** The first `limit` rows of a worksheet as text (empty rows kept, so row numbers stay as Excel shows them). */
function rowsOf(sheet: ExcelJS.Worksheet, limit: number): string[][] {
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: true }, (row, n) => {
    if (n > limit) return
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = cellText(cell)
    })
    rows[n - 1] = cells
  })
  return Array.from({ length: rows.length }, (_, i) => rows[i] ?? [])
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as unknown
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') {
    const o = v as { text?: unknown; richText?: Array<{ text: string }>; result?: unknown; hyperlink?: string }
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('')
    if (typeof o.text === 'string') return o.text
    if (o.result !== undefined && o.result !== null) return String(o.result)
    if (v instanceof Date) return v.toISOString().slice(0, 10)
  }
  return String(v)
}
