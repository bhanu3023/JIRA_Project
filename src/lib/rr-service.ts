/**
 * Round Robin Assignment Service
 * Assigns agents to tickets based on department round robin config + shift timings
 */
import { pgPool as pool } from '@/lib/pg-pool';

export interface RrDepartment {
  name: string;
  order: number;
  isDefault: boolean; // true = used for email tickets
  agents: Array<{
    userId: string;
    name: string;
    isActive: boolean;
    maxTickets: number;
    shiftStart?: string; // "HH:MM" 24h, e.g. "09:00" — undefined means always available
    shiftEnd?: string;   // "HH:MM" 24h, e.g. "17:00"
  }>;
  currentIndex: number; // round robin pointer
  // Deterministic override: tickets of a given product type always go to a specific
  // person in this queue, instead of the normal rotation — e.g. Content -> Mayank,
  // Email/Message -> Ankit. Checked before rotation; doesn't require the person to be
  // in `agents` (they may be a dedicated specialist who never takes rotation tickets).
  productTypeRules?: Array<{ productType: string; userId: string; name: string }>;
}

export interface RrConfig {
  id: string;
  spaceId: string;
  departments: RrDepartment[];
}

/** Returns true if the current server time falls within the agent's shift window.
 *  If no shift is configured the agent is treated as always available.
 *  Handles overnight shifts (e.g. 22:00 – 06:00). */
function isWithinShift(shiftStart?: string, shiftEnd?: string): boolean {
  if (!shiftStart || !shiftEnd) return true;
  const now = new Date();
  const [sh, sm] = shiftStart.split(':').map(Number);
  const [eh, em] = shiftEnd.split(':').map(Number);
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const startMins = sh * 60 + sm;
  const endMins = eh * 60 + em;
  if (startMins <= endMins) {
    return nowMins >= startMins && nowMins < endMins;
  }
  // overnight shift e.g. 22:00 – 06:00
  return nowMins >= startMins || nowMins < endMins;
}

/** Get RR config for a space */
export async function getRrConfig(spaceId: string): Promise<RrConfig | null> {
  const res = await pool.query(`SELECT * FROM rr_config WHERE space_id = $1`, [spaceId]);
  if (!res.rows[0]) return null;
  return { id: res.rows[0].id, spaceId: res.rows[0].space_id, departments: res.rows[0].departments };
}

/** Save/update RR config for a space */
export async function saveRrConfig(spaceId: string, departments: RrDepartment[]): Promise<void> {
  await pool.query(`
    INSERT INTO rr_config (space_id, departments, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (space_id) DO UPDATE SET departments = $2, updated_at = NOW()
  `, [spaceId, JSON.stringify(departments)]);
}

/** Get next agent for a department using round robin, honouring shift timings.
 *  Priority: a matching product-type rule (deterministic, no rotation) → active
 *  agents currently on shift → fall back to all active agents. */
export async function getNextAgent(
  spaceId: string,
  departmentName: string | null | undefined,
  productType?: string | null,
): Promise<{ userId: string; name: string } | null> {
  if (!departmentName) return null;
  const config = await getRrConfig(spaceId);
  if (!config) return null;

  const deptIndex = config.departments.findIndex(d => d.name.toUpperCase() === departmentName.toUpperCase());
  if (deptIndex === -1) return null;

  const dept = config.departments[deptIndex];

  // Product-type override — checked first, doesn't touch the rotation pointer.
  // A ticket's productType can be several comma-joined values (e.g. picked from a
  // multi-select), so match if any of them relates to the rule's configured value.
  if (productType && dept.productTypeRules?.length) {
    const ticketTypes = productType.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    for (const rule of dept.productTypeRules) {
      const ruleType = (rule.productType || '').trim().toLowerCase();
      if (!ruleType) continue;
      if (ticketTypes.some(t => t.includes(ruleType) || ruleType.includes(t))) {
        return { userId: rule.userId, name: rule.name };
      }
    }
  }

  // Treat missing isActive as active (default = active)
  const activeAgents = dept.agents.filter(a => a.isActive !== false);
  if (!activeAgents.length) return null;

  // Filter to agents currently within their shift window
  const onShiftAgents = activeAgents.filter(a => isWithinShift(a.shiftStart, a.shiftEnd));
  // If nobody is on shift right now, fall back to all active agents so tickets always get assigned
  const assignable = onShiftAgents.length > 0 ? onShiftAgents : activeAgents;

  // Guard against undefined/NaN currentIndex
  const currentIdx = typeof dept.currentIndex === 'number' && !isNaN(dept.currentIndex) ? dept.currentIndex : 0;
  const nextIndex = currentIdx % assignable.length;
  const agent = assignable[nextIndex];

  // Advance the pointer (scoped to the assignable pool for fairness)
  config.departments[deptIndex].currentIndex = nextIndex + 1;
  await saveRrConfig(spaceId, config.departments);

  return { userId: agent.userId, name: agent.name };
}

/** Get default department for a space (used for email tickets) */
export async function getDefaultDepartment(spaceId: string): Promise<string | null> {
  const config = await getRrConfig(spaceId);
  if (!config || !config.departments.length) return null;
  const sorted = [...config.departments].sort((a, b) => a.order - b.order);
  const def = sorted.find(d => d.isDefault) || sorted[0];
  return def?.name || null;
}
