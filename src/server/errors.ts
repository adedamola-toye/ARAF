export type ErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "GATE"
  | "RATE_LIMITED"
  | "UNAUTHENTICATED"
  | "CONFIG";

/** Expected, user-presentable domain error. */
export class DomainError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const forbidden = (msg = "You are not authorised to perform this action.") => new DomainError("FORBIDDEN", msg);
export const notFound = (msg = "Not found.") => new DomainError("NOT_FOUND", msg);
export const conflict = (msg: string) => new DomainError("CONFLICT", msg);
export const invalid = (msg: string, fields?: Record<string, string>) => new DomainError("VALIDATION", msg, fields);
export const gate = (msg: string) => new DomainError("GATE", msg);
