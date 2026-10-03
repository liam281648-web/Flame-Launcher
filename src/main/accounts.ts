import { createHash, randomUUID } from 'node:crypto';
import type { Account, AuthSecrets } from '../shared/types';
import { store } from './store';
import { emit } from './events';
import { loginWithMicrosoft, refreshMicrosoft, toAuthError } from './auth/microsoft';

let controller: AbortController | null = null;

export function listAccounts(): Account[] {
  return store.getAccounts();
}

export function setActiveAccount(id: string): Account[] {
  store.setActive(id);
  store.touch(id);
  return listAccounts();
}

export function removeAccount(id: string): Account[] {
  store.removeAccount(id);
  return listAccounts();
}

function offlineUuid(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function addOfflineAccount(username: string): Account[] {
  const name = username.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    throw new Error('Usernames must be 3–16 characters (letters, numbers, underscores).');
  }
  const existing = store.getAccounts().find((a) => a.username.toLowerCase() === name.toLowerCase());
  if (existing) {
    store.setActive(existing.id);
    store.touch(existing.id);
    return listAccounts();
  }
  const account: Account = {
    id: `offline-${name.toLowerCase()}`,
    type: 'offline',
    username: name,
    uuid: offlineUuid(name),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  };
  store.upsertAccount(account);
  return listAccounts();
}

export async function refreshAccount(id: string): Promise<Account | null> {
  const account = store.getAccounts().find((a) => a.id === id);
  if (!account || account.type !== 'microsoft') return account ?? null;

  const secrets = store.getSecrets(id);
  if (!secrets?.refreshToken) return account;

  try {
    const { account: fresh, secrets: next } = await refreshMicrosoft(secrets.refreshToken);
    const merged: Account = { ...account, ...fresh, createdAt: account.createdAt };
    store.upsertAccount(merged, next);
    emit('accounts:update', listAccounts(), store.getActiveId());
    return merged;
  } catch (err) {
    const error = toAuthError(err);
    if (error.code === 'cancelled') return account;
    throw error;
  }
}

export function cancelMicrosoftLogin(): void {
  controller?.abort();
  controller = null;
}

export function beginMicrosoftLogin(): void {
  if (controller) return; // one flow at a time

  controller = new AbortController();
  const signal = controller.signal;

  emit('accounts:authStatus', 'Starting Microsoft sign-in…');

  loginWithMicrosoft(signal, (message) => emit('accounts:authStatus', message))
    .then(({ account, secrets }: { account: Account; secrets: AuthSecrets }) => {
      store.upsertAccount(account, secrets);
      emit('accounts:update', listAccounts(), store.getActiveId());
      emit('accounts:authDone', 'ok');
    })
    .catch((err: unknown) => {
      const error = toAuthError(err, signal);
      if (error.code === 'cancelled') {
        emit('accounts:authDone', 'cancelled');
        return;
      }
      emit('accounts:error', error.message);
      emit('accounts:authDone', 'error');
    })
    .finally(() => {
      controller = null;
    });
}

export function activeAccount(): Account | null {
  return store.getActiveAccount();
}

export function randomSessionId(): string {
  return randomUUID();
}
