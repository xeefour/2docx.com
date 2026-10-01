/** error ที่โค้ดเราจงใจโยน — API จะแปลงเป็น status code ที่ถูกต้อง */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 500,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = new.target.name
    Error.captureStackTrace?.(this, new.target)
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} '${id}' ไม่พบ`, 404)
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message, 409)
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', message, 422, details)
  }
}

export class UpstreamError extends AppError {
  constructor(service: string, message: string, details?: unknown) {
    super('UPSTREAM_ERROR', `${service}: ${message}`, 502, details)
  }
}

export type AppErrorCode = AppError['code']
