'use client';

import { useState } from 'react';
import { Button, ErrorNote, Field, Input, Loading, PageHeader, Panel, Select, Table, Td } from '@/components/ui';
import { api, type ApiError, type Role } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { timeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';

interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  github_linked: boolean;
  disabled_at: string | null;
  last_login_at: string | null;
}

const ROLES: [Role, string][] = [
  ['viewer', 'Viewer: read-only access to sources, routes and events'],
  ['developer', 'Developer: manage sources, destinations, routes and API keys'],
  ['admin', 'Admin: everything above plus members and the audit log'],
  ['owner', 'Owner: full control of the workspace'],
];
const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };

export default function MembersPage() {
  const { can, user } = useAuth();
  const { data, error, loading, reload } = useApi<{ data: Member[] }>('/v1/members');
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<ApiError | null>(null);
  const [rowError, setRowError] = useState<ApiError | null>(null);
  const grantable = ROLES.filter(([r]) => user && RANK[r] <= RANK[user.role]);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/v1/members', {
        method: 'POST',
        json: { email: f.get('email'), name: f.get('name'), role: f.get('role'), temporaryPassword: f.get('temporaryPassword') },
      });
      setAdding(false);
      setFormError(null);
      await reload();
    } catch (err) {
      setFormError(err as ApiError);
    }
  }

  async function update(m: Member, body: { role?: Role; disabled?: boolean }) {
    try {
      await api(`/v1/members/${m.id}`, { method: 'PATCH', json: body });
      setRowError(null);
      await reload();
    } catch (err) {
      setRowError(err as ApiError);
    }
  }

  return (
    <>
      <PageHeader
        title="Members"
        description="Roles follow least privilege. Changes apply to active sessions immediately."
        action={can('members:write') && !adding && <Button onClick={() => setAdding(true)}>Add member</Button>}
      />

      {adding && (
        <Panel title="Add member" className="mb-6">
          <form onSubmit={add} className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2"><ErrorNote error={formError} /></div>
            <Field label="Name"><Input name="name" required autoFocus /></Field>
            <Field label="Email"><Input name="email" type="email" required /></Field>
            <Field label="Role">
              <Select name="role" defaultValue="developer">
                {grantable.map(([r, l]) => <option key={r} value={r}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Temporary password" hint="Share it through a secure channel; ask them to sign in with GitHub or change it.">
              <Input name="temporaryPassword" type="password" required minLength={12} autoComplete="new-password" />
            </Field>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit">Add member</Button>
              <Button type="button" variant="quiet" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </form>
        </Panel>
      )}

      <div className="mb-4"><ErrorNote error={error ?? rowError} /></div>
      {loading && !data ? (
        <Loading />
      ) : (
        <Table head={['Member', 'Role', 'Sign-in', 'Last active', '']}>
          {data?.data.map((m) => {
            const editable = can('members:write') && user && RANK[m.role] <= RANK[user.role];
            return (
              <tr key={m.id} className={m.disabled_at ? 'text-ink-faint' : ''}>
                <Td>
                  <p className="font-medium">
                    {m.name} {m.id === user?.id && <span className="font-normal text-ink-faint">(you)</span>}
                  </p>
                  <p className="text-ink-soft">{m.email}</p>
                </Td>
                <Td>
                  {editable && !m.disabled_at ? (
                    <Select aria-label={`Role for ${m.name}`} value={m.role} className="w-36" onChange={(e) => void update(m, { role: e.target.value as Role })}>
                      {grantable.map(([r]) => <option key={r} value={r}>{r}</option>)}
                    </Select>
                  ) : (
                    <span className="capitalize">{m.role}</span>
                  )}
                </Td>
                <Td className="text-ink-soft">{m.github_linked ? 'GitHub + password' : 'Password'}</Td>
                <Td className="text-ink-soft">{m.disabled_at ? 'Disabled' : m.last_login_at ? timeAgo(m.last_login_at) : 'Never signed in'}</Td>
                <Td className="text-right">
                  {editable && m.id !== user?.id && (
                    <button
                      className={`text-sm hover:underline ${m.disabled_at ? 'text-wire' : 'text-dead'}`}
                      onClick={() => void update(m, { disabled: !m.disabled_at })}
                    >
                      {m.disabled_at ? 'Re-enable' : 'Disable'}
                    </button>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
