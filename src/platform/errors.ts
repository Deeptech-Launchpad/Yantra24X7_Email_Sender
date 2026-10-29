// Errors the API answers in words. Anything else is a 500 with a generic message
// (the detail goes to the log, never to the browser).

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.details = details
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'bad_request', message, details)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Sign in to continue.') {
    super(401, 'unauthorized', message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this.') {
    super(403, 'forbidden', message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(404, 'not_found', message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(409, 'conflict', message, details)
  }
}
