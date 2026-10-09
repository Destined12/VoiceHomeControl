import { EventEmitter } from 'events';

export type ChangeScope = 'commands' | 'devices' | 'all';

export type ChangeEvent = {
  type: 'change';
  scope: ChangeScope;
  [key: string]: unknown;
};

type GlobalWithEvents = typeof globalThis & { __voicehomeEvents?: EventEmitter };

const globalForEvents = globalThis as GlobalWithEvents;

export const events: EventEmitter =
  globalForEvents.__voicehomeEvents ?? new EventEmitter();

events.setMaxListeners(0);
globalForEvents.__voicehomeEvents = events;

export function emitChange(scope: ChangeScope = 'all', extra: Record<string, unknown> = {}): void {
  events.emit('change', { type: 'change', scope, ...extra } satisfies ChangeEvent);
}
