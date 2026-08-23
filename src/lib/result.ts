export interface KeystoneError {
  code: string;
  message: string;
  statusCode?: number;
  details?: Record<string, unknown>;
}

export type Result<T> =
  | { success: true; data: T; error?: undefined }
  | { success: false; data?: undefined; error: KeystoneError };

export function ok<T>(data: T): Result<T> {
  return { success: true, data };
}

export function err<T>(error: KeystoneError): Result<T> {
  return { success: false, error };
}

export function errFromMessage<T>(
  code: string,
  message: string,
  statusCode?: number,
  details?: Record<string, unknown>
): Result<T> {
  return err({ code, message, statusCode, details });
}

export function mapResult<T, U>(result: Result<T>, fn: (data: T) => U): Result<U> {
  if (result.success) {
    return ok(fn(result.data));
  }
  return err(result.error);
}

export async function flatMapResult<T, U>(
  result: Result<T>,
  fn: (data: T) => Promise<Result<U>>
): Promise<Result<U>> {
  if (result.success) {
    return fn(result.data);
  }
  return err(result.error);
}
