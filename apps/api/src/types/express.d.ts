import type { Permission, Role } from '../lib/rbac';

export type Principal =
  | { type: 'user'; id: string; workspaceId: string; role: Role; email: string; permissions: ReadonlySet<Permission> }
  | { type: 'api_key'; id: string; workspaceId: string; permissions: ReadonlySet<Permission> };

declare global {
  namespace Express {
    interface Request {
      id: string;
      principal?: Principal;
      rawBody?: Buffer;
    }
  }
}

export {};
