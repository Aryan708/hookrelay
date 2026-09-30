// Role-based access control. Roles map to permission sets (least privilege);
// API keys carry an explicit subset of permissions as scopes.

export const ROLES = ['owner', 'admin', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'sources:read',
  'sources:write',
  'destinations:read',
  'destinations:write',
  'routes:read',
  'routes:write',
  'events:read',
  'events:write',
  'events:replay',
  'apikeys:read',
  'apikeys:write',
  'members:read',
  'members:write',
  'audit:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const viewer: Permission[] = ['sources:read', 'destinations:read', 'routes:read', 'events:read', 'members:read'];

const developer: Permission[] = [
  ...viewer,
  'sources:write',
  'destinations:write',
  'routes:write',
  'events:write',
  'events:replay',
  'apikeys:read',
  'apikeys:write',
];

const admin: Permission[] = [...developer, 'members:write', 'audit:read'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(viewer),
  developer: new Set(developer),
  admin: new Set(admin),
  owner: new Set(PERMISSIONS),
};

/** Scopes an API key may be granted. Keys can never manage members, keys or audit logs. */
export const API_KEY_SCOPES = ['events:write', 'events:read', 'events:replay', 'sources:read', 'routes:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const ROLE_RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export function hasPermission(perms: ReadonlySet<Permission>, needed: Permission): boolean {
  return perms.has(needed);
}
