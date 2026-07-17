import { Injectable } from '@nitrostack/core';
import type { DesignSession, HistoryEvent, Target } from './types.js';

/**
 * In-memory design records.
 *
 * NitroStack tasks are already in-memory (TaskManager.tasks is a Map), so the server is
 * single-replica by construction — a store with the same lifetime adds no new constraint.
 * Bounded so a long-lived deploy can't leak.
 */
const MAX_SESSIONS = 50;

@Injectable()
export class SessionStore {
  private sessions = new Map<string, DesignSession>();
  private counter = 0;

  create(spec: string, target: Target, clockMhz: number | null): DesignSession {
    const id = `design-${++this.counter}-${Math.random().toString(36).slice(2, 7)}`;
    const s: DesignSession = {
      id,
      spec,
      target,
      clockMhz,
      createdAt: new Date().toISOString(),
      rtl: null,
      verification: null,
      synthesis: null,
      pnr: null,
      cost: null,
      ip: null,
      history: [],
    };
    this.sessions.set(id, s);

    // Evict oldest once over cap.
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    return s;
  }

  get(id: string): DesignSession | undefined {
    return this.sessions.get(id);
  }

  /** Throws a message aimed at the model, so it can self-correct rather than stall. */
  require(id: string): DesignSession {
    const s = this.sessions.get(id);
    if (!s) {
      const known = [...this.sessions.keys()];
      throw new Error(
        `No design with id "${id}". ${
          known.length
            ? `Known designs: ${known.join(', ')}.`
            : 'No designs exist yet — call write_rtl first to create one.'
        }`,
      );
    }
    return s;
  }

  list(): DesignSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  latest(): DesignSession | undefined {
    return this.list()[0];
  }

  record(id: string, ev: Omit<HistoryEvent, 'at'>): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.history.push({ at: new Date().toISOString(), ...ev });
  }
}
