export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new HttpError(403, 'forbidden', message);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
