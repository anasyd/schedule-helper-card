/*
 * Schedule Helper Card — weekly schedules for any device.
 *
 *   type: custom:schedule-helper-card
 *
 * Until 2.0 the schedule card was `custom:beit-schedule-card`; that name still works.
 *
 * Everything the card writes is a native Home Assistant object: a `schedule` helper and an ordinary automation,
 * The data shapes are fixed by docs/contract.md, shared with the Beit app.
 *
 * Pure logic sits at the top and is exported, so `node --test` can import this file.
 * Custom elements are registered only where `customElements` exists.
 */

export const VERSION = '2.0.3-lite';

// ---------------------------------------------------------------------------- week model

/** HA's day keys, Sunday first — the Israeli week. */
export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const DAY_NAMES = {
  he: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
export const DAY_SHORT = {
  he: ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'],
  en: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
};

/** "HH:MM[:SS]" → minutes from midnight. "24:00:00" is 1440, and so is "23:59:59". Minute precision. */
export function parseBlock(hms) {
  const p = String(hms).split(':').map((x) => parseInt(x, 10));
  const minutes = p[0] * 60 + (p[1] || 0);
  return p.length > 2 && p[2] === 59 && minutes === 1439 ? 1440 : minutes;
}

/** Minutes → "HH:MM:00"; 1440 → "24:00:00" (HA's "until midnight"). */
export function formatBlock(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
}

/**
 * A time as typed, always 24-hour: "7", "07", "730", "0730", "7:30", "07.30", "24:00". Minutes from midnight, or null.
 * 24:00 (1440) is allowed; the caller decides where it makes sense.
 */
export function parseTimeInput(text) {
  const v = String(text ?? '').trim().replace(/[.,;]/g, ':');
  let m = v.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) {
    const digits = v.match(/^(\d{3,4})$/)?.[1];
    if (digits) m = [digits, digits.slice(0, -2), digits.slice(-2)];
  }
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

/** Minutes → "HH:MM" for display; 1440 → "24:00". */
export const hm = (m) => formatBlock(m).slice(0, 5);

export const blockLabel = (b) => `${hm(b.start)}–${hm(b.end)}`;

const byStart = (a, b) => a.start - b.start;

export class WeekSchedule {
  constructor({ name = '', days = {} } = {}) {
    this.name = name;
    this.days = {};
    for (const d of DAYS) this.days[d] = (days[d] || []).map((b) => ({ ...b }));
  }

  /** From a `schedule/list` item (or anything with the seven day keys). */
  static fromHA(j) {
    const days = {};
    for (const d of DAYS) {
      // HA lets a block carry extra `data`; it rides along so an edit does not drop it.
      days[d] = (j?.[d] || []).map((b) => ({ start: parseBlock(b.from), end: parseBlock(b.to), ...(b.data ? { data: b.data } : {}) })).sort(byStart);
    }
    return new WeekSchedule({ name: j?.name ?? '', days });
  }

  /** The body HA's `schedule/create` and `schedule/update` expect (minus the id). Days go out Sunday first, sorted. */
  toHA() {
    const out = { name: this.name.trim() };
    for (const d of DAYS) {
      out[d] = [...this.days[d]].sort(byStart).map((b) => ({ from: formatBlock(b.start), to: formatBlock(b.end), ...(b.data ? { data: b.data } : {}) }));
    }
    return out;
  }

  get isEmpty() {
    return DAYS.every((d) => !this.days[d].length);
  }

  clone() {
    return new WeekSchedule({ name: this.name, days: this.days });
  }

  /** Why HA would reject this week, in words; null when it is valid. */
  validate(lang = 'en') {
    const t = STRINGS[lang] || STRINGS.en;
    if (!this.name.trim()) return t.errName;
    for (let i = 0; i < DAYS.length; i++) {
      const blocks = [...this.days[DAYS[i]]].sort(byStart);
      const day = (DAY_NAMES[lang] || DAY_NAMES.en)[i];
      for (let k = 0; k < blocks.length; k++) {
        if (blocks[k].end <= blocks[k].start) return t.errReversed(day);
        if (k > 0 && blocks[k].start < blocks[k - 1].end) return t.errOverlap(day);
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------- the automation a schedule drives

/** Marks automations this card (or the Beit app, which shares the data) wrote, so it knows which ones it may rewrite or delete. */
export const BEIT_MARKER = 'נוצר באפליקציית Beit';

/**
 * What a new schedule does to its device:
 * `{entityId, name, hvacMode?, temperature?, brightnessPct?, turnOffAtEnd = true}`.
 */
const domainOf = (entityId) => String(entityId).split('.')[0];
const given = (v) => v !== null && v !== undefined;

export function onActions(target) {
  const domain = domainOf(target.entityId);
  const t = { entity_id: target.entityId };
  switch (domain) {
    case 'climate':
      if (given(target.temperature)) {
        const data = { temperature: target.temperature };
        if (given(target.hvacMode)) data.hvac_mode = target.hvacMode;
        return [{ action: 'climate.set_temperature', target: t, data }];
      }
      return [{ action: 'climate.set_hvac_mode', target: t, data: { hvac_mode: target.hvacMode ?? 'cool' } }];
    case 'water_heater':
      return [
        { action: 'water_heater.turn_on', target: t },
        ...(given(target.temperature) ? [{ action: 'water_heater.set_temperature', target: t, data: { temperature: target.temperature } }] : []),
      ];
    case 'light':
      return [{ action: 'light.turn_on', target: t, ...(given(target.brightnessPct) ? { data: { brightness_pct: target.brightnessPct } } : {}) }];
    case 'cover':
      return [{ action: 'cover.open_cover', target: t }];
    case 'valve':
      return [{ action: 'valve.open_valve', target: t }];
    default:
      return [{ action: `${domain}.turn_on`, target: t }];
  }
}

export function offActions(target) {
  if (target.turnOffAtEnd === false) return [];
  const domain = domainOf(target.entityId);
  const t = { entity_id: target.entityId };
  switch (domain) {
    case 'cover':
      return [{ action: 'cover.close_cover', target: t }];
    case 'valve':
      return [{ action: 'valve.close_valve', target: t }];
    case 'media_player':
      return [{ action: 'media_player.media_pause', target: t }];
    default:
      return [{ action: `${domain}.turn_off`, target: t }];
  }
}

/** The automation that makes a schedule drive a device (contract §2). */
export function buildScheduleAutomation({ id, scheduleEntityId, scheduleName, target }) {
  // A restart makes the schedule pass through "unavailable"; that is not an edge.
  const notFrom = ['unavailable', 'unknown'];
  const off = offActions(target);
  const trigger = (to, tid) => ({ trigger: 'state', entity_id: [scheduleEntityId], to: [to], not_from: notFrom, id: tid });
  const branch = (tid, sequence) => ({ conditions: [{ condition: 'trigger', id: tid }], sequence });
  return {
    id,
    alias: scheduleAlias(scheduleName),
    description: `${BEIT_MARKER} — ${target.name ?? target.entityId} לפי ${scheduleEntityId}`,
    triggers: [trigger('on', 'schedule_on'), ...(off.length ? [trigger('off', 'schedule_off')] : [])],
    conditions: [],
    actions: [{ choose: [branch('schedule_on', onActions(target)), ...(off.length ? [branch('schedule_off', off)] : [])] }],
    mode: 'queued',
  };
}

/** True for an automation config carrying the marker (so the card may rewrite or delete it). */
export const isOurs = (config) => String(config?.description ?? '').includes(BEIT_MARKER);

// Key order is HA's business; compare configs by content.
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
export const sameConfig = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export const scheduleAlias = (scheduleName) => `Beit · ${scheduleName}`;

/**
 * Reads back what an automation written by buildScheduleAutomation does: `{scheduleEntityId, scheduleName, target}`.
 * Null unless it carries the marker and is exactly in that shape (so it was not edited by hand since): the card never
 * rewrites what it could not write again.
 */
export function parseScheduleAutomation(config) {
  if (!isOurs(config)) return null;
  const choose = config.actions?.[0]?.choose;
  const on = choose?.[0]?.sequence;
  const scheduleEntityId = config.triggers?.[0]?.entity_id?.[0];
  const first = on?.[0];
  const entityId = first?.target?.entity_id;
  if (!scheduleEntityId || typeof entityId !== 'string' || !String(config.alias ?? '').startsWith('Beit · ')) return null;
  const data = first.data || {};
  const name = String(config.description).match(/ — (.*) לפי schedule\.[a-z0-9_]+$/)?.[1] ?? entityId;
  const target = {
    entityId,
    name,
    hvacMode: data.hvac_mode ?? null,
    temperature: data.temperature ?? on[1]?.data?.temperature ?? null,
    brightnessPct: data.brightness_pct ?? null,
    turnOffAtEnd: (choose?.length ?? 0) > 1,
  };
  const scheduleName = config.alias.slice('Beit · '.length);
  const again = buildScheduleAutomation({ id: config.id, scheduleEntityId, scheduleName, target });
  return sameConfig(again, config) ? { scheduleEntityId, scheduleName, target } : null;
}

// ---------------------------------------------------------------------------- time

const MINUTES_PER_WEEK = 7 * 1440;

/**
 * Whether a week is "on" at `now` (local time) and when it next changes, the way HA computes a schedule's state
 * and `next_event`. Adjacent ranges (Friday until 24:00, Saturday from 00:00) are one range.
 */
export function weekStatus(week, now = new Date()) {
  const ranges = [];
  DAYS.forEach((d, i) => {
    for (const b of week.days[d]) ranges.push([i * 1440 + b.start, i * 1440 + b.end]);
  });
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  if (!merged.length) return { on: false, next: null };
  if (merged.length === 1 && merged[0][0] === 0 && merged[0][1] === MINUTES_PER_WEEK) return { on: true, next: null };
  // A range that runs to the end of Saturday continues into Sunday's first one.
  if (merged.length > 1 && merged.at(-1)[1] === MINUTES_PER_WEEK && merged[0][0] === 0) {
    const tail = merged.pop();
    merged[0] = [tail[0], merged[0][1] + MINUTES_PER_WEEK];
  }
  const t = now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const inside = (r, x) => x >= r[0] && x < r[1];
  const on = merged.find((r) => inside(r, t) || inside(r, t + MINUTES_PER_WEEK));
  let delta;
  if (on) {
    delta = (inside(on, t) ? on[1] - t : on[1] - (t + MINUTES_PER_WEEK));
  } else {
    delta = Math.min(...merged.map((r) => ((r[0] - t) % MINUTES_PER_WEEK + MINUTES_PER_WEEK) % MINUTES_PER_WEEK));
  }
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + Math.round(delta + now.getSeconds() / 60)); // local-time arithmetic: DST-safe
  return { on: !!on, next };
}

// ---------------------------------------------------------------------------- Home Assistant operations
//
// Every function takes `hass`: anything with callWS, callApi, callService and a *live* `states` (the card passes an
// adapter that always reads its latest hass). The order of calls follows the Beit app's home_store.dart.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HA's own error text: WebSocket errors carry `message`, REST ones (hass.callApi) `body.message` or `error`. */
export const errorText = (err) =>
  err?.body?.message || err?.message || (typeof err?.error === 'string' && err.error) || (typeof err === 'string' ? err : JSON.stringify(err));

/** Waits for an entity to appear in the live state, matched by `test`. */
export async function waitForEntity(hass, test, { tries = 40, every = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    const hit = Object.values(hass.states || {}).find(test);
    if (hit) return hit;
    await sleep(every);
  }
  throw new Error('Home Assistant did not report the new entity');
}

/**
 * The helper id behind each schedule entity: its registry unique_id. Usually `schedule.<id>`, but the user may have
 * renamed the entity. `{entity_id: schedule_id}`.
 */
export async function scheduleIdsOf(hass, entityIds) {
  const pairs = await Promise.all(entityIds.map(async (id) => {
    const e = await hass.callWS({ type: 'config/entity_registry/get', entity_id: id }).catch(() => null);
    return [id, e?.platform === 'schedule' && e.unique_id ? String(e.unique_id) : null];
  }));
  return Object.fromEntries(pairs.filter(([, u]) => u));
}

/** The entity HA made for a new schedule helper: `schedule.<id>`, or `schedule.<id>_2` when that id is taken. */
async function scheduleEntityFor(hass, scheduleId, { tries = 40, every = 150 } = {}) {
  const re = new RegExp(`^schedule\\.${scheduleId}(_\\d+)?$`);
  for (let i = 0; i < tries; i++) {
    const candidates = Object.keys(hass.states || {}).filter((id) => re.test(id));
    if (candidates.length) {
      const ids = await scheduleIdsOf(hass, candidates);
      const hit = candidates.find((c) => ids[c] === scheduleId);
      if (hit) return hit;
    }
    await sleep(every);
  }
  throw new Error('Home Assistant did not report the new schedule');
}

/** `{id: WeekSchedule}` for every UI-managed schedule. */
export async function listSchedules(hass) {
  const list = await hass.callWS({ type: 'schedule/list' });
  return Object.fromEntries(list.map((s) => [s.id, WeekSchedule.fromHA(s)]));
}

/**
 * The weeks of any schedule entities, UI or YAML, through the schedule.get_schedule action. Unlike schedule/list it
 * is open to every user. `{entity_id: WeekSchedule}`.
 */
export async function readSchedules(hass, entityIds) {
  if (!entityIds.length) return {};
  const res = await hass.callService('schedule', 'get_schedule', {}, { entity_id: entityIds }, false, true);
  const weeks = res?.response ?? {};
  return Object.fromEntries(Object.entries(weeks).map(([id, days]) => [id, WeekSchedule.fromHA({ ...days, name: '' })]));
}

export const updateSchedule = (hass, id, week) => hass.callWS({ type: 'schedule/update', schedule_id: id, ...week.toHA() });

export async function automationsFor(hass, entityId) {
  const r = await hass.callWS({ type: 'search/related', item_type: 'entity', item_id: entityId });
  return r?.automation || [];
}

export async function automationConfig(hass, automationEntityId) {
  const r = await hass.callWS({ type: 'automation/config', entity_id: automationEntityId });
  return r?.config ?? null;
}

/**
 * Creates the schedule helper and the automation that drives `target` from it; if the automation cannot be written,
 * the helper is deleted again. Returns the new schedule's entity id.
 */
export async function createScheduleWithAutomation(hass, week, target, { waitOptions } = {}) {
  const created = await hass.callWS({ type: 'schedule/create', ...week.toHA() });
  let scheduleEntityId;
  try {
    scheduleEntityId = await scheduleEntityFor(hass, created.id, waitOptions);
  } catch (err) {
    await hass.callWS({ type: 'schedule/delete', schedule_id: created.id });
    throw err;
  }
  const automationId = String(Date.now());
  try {
    await hass.callApi(
      'POST',
      `config/automation/config/${automationId}`,
      buildScheduleAutomation({ id: automationId, scheduleEntityId, scheduleName: week.name.trim(), target }),
    );
  } catch (err) {
    // Half a schedule (a helper that drives nothing) is worse than none.
    await hass.callWS({ type: 'schedule/delete', schedule_id: created.id });
    throw err;
  }
  return scheduleEntityId;
}

/**
 * Deletes a schedule and automations whose configuration exactly matches what this card creates.
 * Edited or hand-written automations are left alone; their names are returned.
 */
export async function deleteSchedule(hass, scheduleEntityId, scheduleId = scheduleEntityId.slice('schedule.'.length)) {
  const kept = [];
  for (const a of await automationsFor(hass, scheduleEntityId)) {
    const cfg = await automationConfig(hass, a);
    if (parseScheduleAutomation(cfg)?.scheduleEntityId === scheduleEntityId && cfg?.id != null) {
      await hass.callApi('DELETE', `config/automation/config/${cfg.id}`);
    }
    else kept.push(hass.states?.[a]?.attributes?.friendly_name || a);
  }
  await hass.callWS({ type: 'schedule/delete', schedule_id: scheduleId });
  return kept;
}

/**
 * Rewrites the automation the card wrote for a schedule, under the same id, to drive `target` (and carry the schedule's
 * current name). Only for a config parseScheduleAutomation understands. Returns false when nothing would change.
 */
export async function rewriteScheduleAutomation(hass, config, { scheduleName, target }) {
  const parsed = parseScheduleAutomation(config);
  if (!parsed) throw new Error('This automation was edited by hand; change it in Home Assistant');
  const next = buildScheduleAutomation({
    id: config.id,
    scheduleEntityId: parsed.scheduleEntityId,
    scheduleName: (scheduleName ?? parsed.scheduleName).trim(),
    target: target ?? parsed.target,
  });
  if (sameConfig(next, config)) return false;
  await hass.callApi('POST', `config/automation/config/${config.id}`, next);
  return true;
}

/**
 * After a schedule is renamed: the automations the card wrote for it follow, but only those still named
 * `Beit · <old name>`; an alias the user changed stays. Returns the entity ids that were renamed.
 */
export async function renameScheduleAutomations(hass, automationEntityIds, oldName, newName) {
  const renamed = [];
  if (oldName.trim() === newName.trim()) return renamed;
  for (const id of automationEntityIds) {
    const cfg = await automationConfig(hass, id);
    if (!isOurs(cfg) || cfg.alias !== scheduleAlias(oldName.trim()) || cfg.id == null) continue;
    await hass.callApi('POST', `config/automation/config/${cfg.id}`, { ...cfg, alias: scheduleAlias(newName.trim()) });
    renamed.push(id);
  }
  return renamed;
}

export const setAutomationEnabled = (hass, automationEntityId, enabled) =>
  hass.callService('automation', enabled ? 'turn_on' : 'turn_off', {}, { entity_id: automationEntityId });

// ---- the Schedule Helper dashboard ----

/** The dashboard the card can create: a new one in the sidebar. Never an existing one changed. */
export const DASHBOARD = { url_path: 'schedule-helper', view: 'schedules', title: 'Schedule Helper', icon: 'mdi:calendar-clock' };
// Where the dashboard lived before the card was renamed (1.2.x): found too, so it is never made twice.
const LEGACY_DASHBOARD_PATHS = ['beit-schedules'];

export function dashboardConfig() {
  return {
    title: DASHBOARD.title,
    views: [{ title: DASHBOARD.title, path: DASHBOARD.view, cards: [{ type: 'custom:schedule-helper-card' }] }],
  };
}

export async function findDashboard(hass) {
  const list = await hass.callWS({ type: 'lovelace/dashboards/list' });
  return list.find((d) => d.url_path === DASHBOARD.url_path)
    || list.find((d) => LEGACY_DASHBOARD_PATHS.includes(d.url_path)) || null;
}

/**
 * Creates the Schedule Helper dashboard. If one is already at that address it is left as it is (`created: false`). If its
 * content cannot be saved, the empty dashboard just created is removed again.
 */
export async function createDashboard(hass) {
  const existing = await findDashboard(hass);
  if (existing) return { ...existing, created: false };
  const created = await hass.callWS({
    type: 'lovelace/dashboards/create',
    url_path: DASHBOARD.url_path,
    title: DASHBOARD.title,
    icon: DASHBOARD.icon,
    show_in_sidebar: true,
    require_admin: false,
    mode: 'storage',
  });
  try {
    await hass.callWS({ type: 'lovelace/config/save', url_path: DASHBOARD.url_path, config: dashboardConfig() });
  } catch (err) {
    await hass.callWS({ type: 'lovelace/dashboards/delete', dashboard_id: created.id }).catch(() => {});
    throw err;
  }
  return { ...created, created: true };
}

export const entityName = (st) => st?.attributes?.friendly_name || st?.entity_id || '';

// ---------------------------------------------------------------------------- device picker

/** Domains a schedule can drive, in the order the picker lists them (the app's tile domains, minus scene/script/lock). */
export const PICKABLE_DOMAINS = ['light', 'switch', 'fan', 'cover', 'climate', 'water_heater', 'media_player', 'input_boolean', 'vacuum', 'siren', 'valve'];

/**
 * The picker's sections: devices grouped by area (the entity's own area, else its device's), areas by name, then the
 * ones with no area. Hidden and auxiliary (config/diagnostic) entities are left out, as the app does.
 * `display` is `config/entity_registry/list_for_display`.
 */
export function deviceSections({ states, display, devices = [], areas = [], domains = null, only = null }, query = '', noAreaTitle = 'No room', lang = 'en') {
  const meta = Object.fromEntries((display?.entities || []).map((e) => [e.ei, e]));
  const deviceArea = Object.fromEntries(devices.map((d) => [d.id, d.area_id]));
  const q = query.trim().toLowerCase();
  const byArea = new Map();
  for (const e of Object.values(states || {})) {
    const domain = domainOf(e.entity_id);
    if (!PICKABLE_DOMAINS.includes(domain)) continue;
    if (domains?.length && !domains.includes(domain)) continue; // the card's device_domains
    if (only && domain !== only) continue; // the picker's type chip
    const m = meta[e.entity_id];
    if (m && (m.hb || m.ec !== undefined && m.ec !== null)) continue;
    const areaId = m?.ai ?? (m?.di ? deviceArea[m.di] : null) ?? null;
    if (!byArea.has(areaId)) byArea.set(areaId, []);
    byArea.get(areaId).push(e);
  }
  const order = (e) => PICKABLE_DOMAINS.indexOf(domainOf(e.entity_id));
  const sorted = [...areas].sort((a, b) => a.name.localeCompare(b.name, lang));
  const sections = [
    ...sorted.map((a) => ({ areaId: a.area_id, title: a.name })),
    { areaId: null, title: noAreaTitle },
  ];
  return sections
    .map((sec) => ({
      ...sec,
      entities: (byArea.get(sec.areaId) || [])
        .filter((e) => !q || entityName(e).toLowerCase().includes(q) || sec.title.toLowerCase().includes(q) || e.entity_id.includes(q))
        .sort((a, b) => order(a) - order(b) || entityName(a).localeCompare(entityName(b), lang)),
    }))
    .filter((sec) => sec.entities.length);
}

const VERBS = {
  he: { on: 'נדלק', open: 'נפתח', close: 'נסגר', off: 'נכבה', pause: 'מושהה', stays: 'נשאר כמו שהוא', play: 'מופעל' },
  en: { on: 'turns on', open: 'opens', close: 'closes', off: 'turns off', pause: 'pauses', stays: 'stays as it is', play: 'turns on' },
};

/** "בתחילת הטווח: נדלק (קירור, 24°) · בסופו: נכבה": what a target does, in words. */
export function actionSummary(target, lang = 'en') {
  const t = STRINGS[lang];
  const v = VERBS[lang];
  const domain = domainOf(target.entityId);
  const details = [
    target.hvacMode && domain === 'climate' ? t.hvac[target.hvacMode] || target.hvacMode : null,
    given(target.temperature) ? `${target.temperature}°` : null,
    given(target.brightnessPct) ? `${target.brightnessPct}%` : null,
  ].filter(Boolean);
  const start = (domain === 'cover' || domain === 'valve' ? v.open : domain === 'media_player' ? v.play : v.on) +
    (details.length ? ` (${details.join(', ')})` : '');
  const end = target.turnOffAtEnd === false ? v.stays
    : domain === 'cover' || domain === 'valve' ? v.close : domain === 'media_player' ? v.pause : v.off;
  return `${t.atStart}: ${start} · ${t.atEnd}: ${end}`;
}

/** What the editor offers for a device: HVAC modes, a temperature range, brightness. */
export function actionOptions(st) {
  const domain = domainOf(st.entity_id);
  const a = st.attributes || {};
  const hvacModes = domain === 'climate' ? (a.hvac_modes || []).filter((m) => m !== 'off') : [];
  const temp = domain === 'climate' || domain === 'water_heater'
    ? {
      min: Number(a.min_temp ?? 16),
      max: Number(a.max_temp ?? 30),
      step: Number(a.target_temp_step) > 0 ? Number(a.target_temp_step) : 1,
      initial: Number(a.temperature ?? Math.round(((a.min_temp ?? 16) + (a.max_temp ?? 30)) / 2)),
    }
    : null;
  const brightness = domain === 'light' && (a.supported_color_modes || []).some((m) => m !== 'onoff');
  return { domain, hvacModes, defaultHvac: hvacModes.includes('cool') ? 'cool' : hvacModes[0] ?? null, temp, brightness };
}

// ---------------------------------------------------------------------------- strings

export const STRINGS = {
  he: {
    errName: 'צריך שם לתזמון',
    errReversed: (day) => `ביום ${day}: שעת הסיום לפני שעת ההתחלה`,
    errOverlap: (day) => `ביום ${day}: יש טווחים חופפים`,
    schedules: 'תזמונים',
    newSchedule: 'תזמון חדש',
    onNow: 'פועל עכשיו',
    offNow: 'כבוי',
    starts: 'מתחיל',
    ends: 'נגמר',
    today: 'היום',
    tomorrow: 'מחר',
    onDay: (day) => `ביום ${day}`,
    at: (when, time) => `${when} ב-${time}`,
    yaml: 'מוגדר ב-YAML — לקריאה בלבד',
    noSchedules: 'אין תזמונים להצגה',
    loading: 'טוען…',
    readOnly: 'צפייה בלבד — רק מנהל יכול לערוך',
    editSchedule: 'עריכת תזמון',
    name: 'שם התזמון',
    device: 'מכשיר',
    chooseDevice: 'בחר מכשיר',
    changeDevice: 'החלף',
    searchDevice: 'חיפוש מכשיר או חדר',
    noArea: 'ללא חדר',
    noDevices: 'לא נמצאו מכשירים',
    whileActive: 'מצב בזמן פעילות',
    whatItDoes: 'מה הוא עושה',
    handEdited: 'האוטומציה של התזמון נערכה ידנית — את המכשיר ואת הפעולה משנים בה, ב-Home Assistant.',
    setTemp: 'לקבוע טמפרטורה',
    brightness: 'בהירות',
    turnOffAtEnd: 'לכבות בסוף הטווח',
    closeAtEnd: 'לסגור בסוף הטווח',
    drives: 'מפעיל את',
    autoOn: 'אוטומציה פעילה',
    autoOff: 'אוטומציה כבויה',
    drivesNothing: 'אף אוטומציה לא משתמשת בתזמון הזה — הוא לא מפעיל כלום.',
    hours: 'שעות פעילות',
    addRange: 'טווח',
    rangeDays: 'ימים לטווח הזה',
    everyDay: 'כל יום',
    from: 'מ־',
    to: 'עד',
    midnightHint: 'שעון 24 שעות; סיום 00:00 או 24:00 = עד חצות',
    errTime: 'שעה לא תקינה — כתבו למשל 7:30 או 2330',
    ok: 'אישור',
    cancel: 'ביטול',
    copyTo: (day) => `להעתיק את יום ${day} אל…`,
    weekdays: 'ימי חול',
    wholeWeek: 'כל השבוע',
    copy: 'העתק',
    copyDays: 'העתק לימים אחרים',
    clearAll: 'נקה הכול',
    save: 'שמור',
    delete: 'מחק',
    close: 'סגור',
    back: 'חזרה',
    deleteQ: 'למחוק את התזמון?',
    deleteText: 'האוטומציה שנוצרה עבורו תימחק גם היא. אוטומציות שנכתבו ידנית יישארו.',
    kept: (list) => `נשארו אוטומציות שמפנות לתזמון שנמחק: ${list}`,
    saveFailed: (e) => `השמירה נכשלה: ${e}`,
    deleteFailed: (e) => `המחיקה נכשלה: ${e}`,
    errEmpty: 'צריך לפחות טווח שעות אחד',
    errDevice: 'בחר מכשיר שהתזמון יפעיל',
    errRange: 'שעת הסיום לפני שעת ההתחלה',
    editRange: 'עריכת טווח',
    removeRange: 'מחיקת טווח',
    hvac: { cool: 'קירור', heat: 'חימום', heat_cool: 'אוטומטי', auto: 'אוטומטי', dry: 'ייבוש', fan_only: 'מאוורר' },
    saved: 'התזמון נשמר',
    created: 'התזמון נוצר',
    namePlaceholder: 'יתמלא משם המכשיר',
    atStart: 'בתחילת הטווח',
    atEnd: 'בסופו',
    edGeneral: 'כללי',
    edTitle: 'כותרת',
    edShowAdd: 'כפתור "תזמון חדש"',
    edDeviceDomains: 'סוגי מכשירים לתזמון',
    edDeviceDomainsHint: 'רק הסוגים המסומנים יופיעו בבחירת מכשיר.',
    allTypes: 'הכול',
    domainName: { light: 'תאורה', switch: 'מתגים ושקעים', fan: 'מאווררים', cover: 'תריסים', climate: 'מזגנים', water_heater: 'דודים',
      media_player: 'נגנים', input_boolean: 'מתגים וירטואליים', vacuum: 'שואבים', siren: 'צופרים', valve: 'ברזים' },
    edSchedules: 'תזמונים בכרטיס',
    edSchedulesHint: 'סמנו את התזמונים שיוצגו.',
    edAll: 'הכול',
    edNone: 'כלום',
    edDashboard: 'דשבורד Schedule Helper בסרגל הצד',
    edDashboardHint: 'יוצר דשבורד חדש בשם Schedule Helper עם כרטיס התזמונים. דשבורדים קיימים לא משתנים.',
    edDashboardCreate: 'צור דשבורד Schedule Helper',
    edDashboardExists: 'הדשבורד כבר קיים.',
    edDashboardCreated: 'הדשבורד נוצר ומופיע בסרגל הצד.',
    edDashboardOpen: 'פתח',
    edHeight: 'גובה',
    edHeightHint: 'אוטומטי — או למשל 500px או 60vh; התוכן נגלל בתוך הכרטיס',
  },
  en: {
    errName: 'The schedule needs a name',
    errReversed: (day) => `${day}: a range ends before it starts`,
    errOverlap: (day) => `${day}: ranges overlap`,
    schedules: 'Schedules',
    newSchedule: 'New schedule',
    onNow: 'On now',
    offNow: 'Off',
    starts: 'starts',
    ends: 'ends',
    today: 'today',
    tomorrow: 'tomorrow',
    onDay: (day) => day,
    at: (when, time) => `${when} at ${time}`,
    yaml: 'Defined in YAML — read only',
    noSchedules: 'No schedules to show',
    loading: 'Loading…',
    readOnly: 'View only — only an administrator can edit',
    editSchedule: 'Edit schedule',
    name: 'Schedule name',
    device: 'Device',
    chooseDevice: 'Choose a device',
    changeDevice: 'Change',
    searchDevice: 'Search a device or room',
    noArea: 'No room',
    noDevices: 'No devices found',
    whileActive: 'Mode while active',
    whatItDoes: 'What it does',
    handEdited: "This schedule's automation was edited by hand; change its device and action in Home Assistant.",
    setTemp: 'Set a temperature',
    brightness: 'Brightness',
    turnOffAtEnd: 'Turn off at the end',
    closeAtEnd: 'Close at the end',
    drives: 'Drives',
    autoOn: 'Automation on',
    autoOff: 'Automation off',
    drivesNothing: 'No automation uses this schedule, so it drives nothing.',
    hours: 'Active hours',
    addRange: 'Range',
    rangeDays: 'Days for this range',
    everyDay: 'Every day',
    from: 'From',
    to: 'To',
    midnightHint: '24-hour clock; an end of 00:00 or 24:00 means until midnight',
    errTime: 'Not a time. Type e.g. 7:30 or 2330',
    ok: 'OK',
    cancel: 'Cancel',
    copyTo: (day) => `Copy ${day} to…`,
    weekdays: 'Weekdays',
    wholeWeek: 'Whole week',
    copy: 'Copy',
    copyDays: 'Copy to other days',
    clearAll: 'Clear all',
    save: 'Save',
    delete: 'Delete',
    close: 'Close',
    back: 'Back',
    deleteQ: 'Delete this schedule?',
    deleteText: 'The automation created for it is deleted too. Automations written by hand stay.',
    kept: (list) => `These automations still refer to the deleted schedule: ${list}`,
    saveFailed: (e) => `Saving failed: ${e}`,
    deleteFailed: (e) => `Deleting failed: ${e}`,
    errEmpty: 'Add at least one range of hours',
    errDevice: 'Choose the device this schedule drives',
    errRange: 'The range ends before it starts',
    editRange: 'Edit range',
    removeRange: 'Remove range',
    hvac: { cool: 'Cool', heat: 'Heat', heat_cool: 'Auto', auto: 'Auto', dry: 'Dry', fan_only: 'Fan' },
    saved: 'Schedule saved',
    created: 'Schedule created',
    namePlaceholder: "Filled in from the device's name",
    atStart: 'When a range starts',
    atEnd: 'when it ends',
    edGeneral: 'General',
    edTitle: 'Title',
    edShowAdd: '"New schedule" button',
    edDeviceDomains: 'Device types to schedule',
    edDeviceDomainsHint: 'Only the ticked types appear when choosing a device.',
    allTypes: 'All',
    domainName: { light: 'Lights', switch: 'Switches & plugs', fan: 'Fans', cover: 'Covers', climate: 'Air conditioners', water_heater: 'Water heaters',
      media_player: 'Media players', input_boolean: 'Virtual switches', vacuum: 'Vacuums', siren: 'Sirens', valve: 'Valves' },
    edSchedules: 'Schedules on the card',
    edSchedulesHint: 'Tick the schedules to show.',
    edAll: 'All',
    edNone: 'None',
    edDashboard: 'A Schedule Helper dashboard in the sidebar',
    edDashboardHint: 'Creates a new dashboard named Schedule Helper with one schedule card. Existing dashboards are not changed.',
    edDashboardCreate: 'Create the Schedule Helper dashboard',
    edDashboardExists: 'The dashboard already exists.',
    edDashboardCreated: 'The dashboard was created; it is in the sidebar.',
    edDashboardOpen: 'Open',
    edHeight: 'Height',
    edHeightHint: 'Automatic, or e.g. 500px or 60vh; the content scrolls inside the card',
  },
};

/** A config height ("500px", "60vh", or a bare number of pixels) as CSS; null when the card should size itself. */
export function cssHeight(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const v = String(value).trim();
  return /^\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
}

/** The user's language in HA's profile: Hebrew ('he', or the old 'iw') gets Hebrew; anything else, or none, English. */
export const langOf = (hass) => (/^(he|iw)\b/.test(String(hass?.locale?.language || hass?.language || 'en')) ? 'he' : 'en');

/** "היום ב-16:00" / "tomorrow at 16:00" / "ביום שישי ב-16:00". */
export function formatWhen(date, now = new Date(), lang = 'en') {
  const t = STRINGS[lang];
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(date) - midnight(now)) / 86400000);
  const when = days === 0 ? t.today : days === 1 ? t.tomorrow : t.onDay(DAY_NAMES[lang][date.getDay()]);
  return t.at(when, time);
}

// ---------------------------------------------------------------------------- UI helpers

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Material Design Icons paths (Apache 2.0), inlined: HA's own icon elements are not ours to depend on.
const ICONS = {
  plus: 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z',
  close: 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  delete: 'M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z',
  copy: 'M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z',
  clock: 'M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z',
  minus: 'M19,13H5V11H19V13Z',
  back: 'M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

const BASE_STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  * { box-sizing: border-box; }
  .ic { width: 20px; height: 20px; fill: currentColor; flex: none; }
  [dir=rtl] .ic.flip { transform: scaleX(-1); }
  button { font: inherit; color: inherit; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 18px; cursor: pointer;
    border: 1px solid var(--divider-color); background: transparent; color: var(--primary-color); font-size: 14px; font-weight: 500; }
  .btn.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .btn.danger { color: var(--error-color, #db4437); }
  .btn:disabled { opacity: .5; cursor: default; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%;
    border: 0; background: transparent; cursor: pointer; color: var(--secondary-text-color); flex: none; }
  .icon-btn:hover, .btn:hover { background: color-mix(in srgb, var(--primary-color) 10%, transparent); }
  .btn.primary:hover { filter: brightness(1.08); background: var(--primary-color); }
  :focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  /* With a height set, the header stays put and the rest scrolls. */
  ha-card.fixed { display: flex; flex-direction: column; overflow: hidden; }
  ha-card.fixed .body { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  ha-card.fixed .header { flex: none; }
  ha-card.fixed .scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .header { display: flex; align-items: center; gap: 8px; padding: 16px 16px 8px; }
  .header h2 { margin: 0; flex: 1; font-size: 20px; font-weight: 500; color: var(--ha-card-header-color, var(--primary-text-color)); }
  .muted { color: var(--secondary-text-color); }
  .small { font-size: 12px; }
  .hint { color: var(--secondary-text-color); font-size: 13px; padding: 8px 16px 16px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 10px; font-size: 12px; line-height: 18px;
    background: color-mix(in srgb, var(--chip-color, var(--primary-color)) 16%, transparent); color: var(--primary-text-color); white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--disabled-text-color, #9e9e9e); flex: none; }
  .dot.on { background: var(--success-color, #43a047); }
  /* a switch built from a checkbox */
  .switch { position: relative; display: inline-block; width: 36px; height: 20px; flex: none; }
  .switch input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; z-index: 1; }
  .switch .track { position: absolute; inset: 3px 0; border-radius: 7px; background: var(--switch-unchecked-track-color, #9e9e9e); opacity: .5; transition: .15s; }
  .switch .knob { position: absolute; top: 0; inset-inline-start: 0; width: 20px; height: 20px; border-radius: 50%;
    background: var(--switch-unchecked-button-color, #fafafa); box-shadow: 0 1px 3px rgba(0,0,0,.4); transition: .15s; }
  .switch input:checked ~ .track { background: var(--switch-checked-track-color, var(--primary-color)); }
  .switch input:checked ~ .knob { inset-inline-start: 16px; background: var(--switch-checked-button-color, var(--primary-color)); }
  .switch.partial input ~ .knob { inset-inline-start: 8px; background: var(--switch-checked-button-color, var(--primary-color)); }
  .switch input:disabled { cursor: default; }
  .switch input:disabled ~ .knob, .switch input:disabled ~ .track { opacity: .35; }
  .switch input:focus-visible ~ .knob { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  .toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 10; max-width: min(560px, calc(100vw - 32px));
    background: var(--primary-text-color); color: var(--card-background-color, #fff); padding: 10px 16px; border-radius: 8px; font-size: 14px;
    box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .toast[hidden] { display: none; }
`;

const switchHtml = ({ checked = false, partial = false, disabled = false, label = '', attrs = '' } = {}) =>
  `<span class="switch ${partial ? 'partial' : ''}"><input type="checkbox" role="switch" ${checked ? 'checked' : ''}
    aria-checked="${partial ? 'mixed' : checked}" ${disabled ? 'disabled' : ''} aria-label="${esc(label)}" ${attrs}>
    <span class="track"></span><span class="knob"></span></span>`;

const Base = globalThis.HTMLElement || class {};

/** Shared card behavior: shadow root, language, a live Home Assistant adapter, and toast messages. */
class CardBase extends Base {
  constructor() {
    super();
    // The ops wait for entities to appear, so they need the latest hass, not the one they started with.
    const self = this;
    this._h = {
      callWS: (m) => self._hass.callWS(m),
      callApi: (...a) => self._hass.callApi(...a),
      callService: (...a) => self._hass.callService(...a),
      get states() {
        return self._hass?.states || {};
      },
    };
  }

  get _lang() {
    return langOf(this._hass);
  }

  get _t() {
    return STRINGS[this._lang];
  }

  get _isAdmin() {
    return this._hass?.user?.is_admin !== false;
  }

  _root() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    return this.shadowRoot;
  }

  _toast(text, ms = 6000) {
    const root = this._root();
    // A modal dialog sits in the top layer: a toast outside it would be hidden behind its backdrop.
    const host = root.querySelector('dialog[open]') || root;
    // A direct child: `:scope >` matches nothing when asked of a shadow root.
    let el = [...host.children].find((c) => c.classList.contains('toast'));
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      host.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (el.hidden = true), ms);
  }

  /** Runs a write; HA's error text goes to the toast. Returns the result, or undefined when it failed. */
  async _run(fn) {
    try {
      return await fn();
    } catch (err) {
      this._toast(errorText(err));
      return undefined;
    }
  }

  _dirAttr() {
    return this._lang === 'he' ? 'rtl' : 'ltr';
  }

  /** Writes the card body: a header and a scroll area, which keeps its scroll position across redraws. */
  _paint(header, content) {
    const root = this._root();
    const card = root.querySelector('ha-card');
    const height = cssHeight(this._config.height);
    card.classList.toggle('fixed', !!height);
    card.style.height = height || '';
    const body = root.querySelector('.body');
    const top = body.querySelector('.scroll')?.scrollTop ?? 0;
    body.setAttribute('dir', this._dirAttr());
    body.innerHTML = `${header}<div class="scroll">${content}</div>`;
    body.querySelector('.scroll').scrollTop = top;
  }
}

// ---------------------------------------------------------------------------- schedule-helper-card

class ScheduleHelperCard extends CardBase {
  static getStubConfig() {
    return { show_add: true };
  }

  static getConfigElement() {
    return document.createElement('schedule-helper-card-editor');
  }

  setConfig(config) {
    if (config?.entities && !Array.isArray(config.entities)) throw new Error('entities must be a list');
    if (config?.hide_entities && !Array.isArray(config.hide_entities)) throw new Error('hide_entities must be a list');
    if (config?.device_domains && !Array.isArray(config.device_domains)) throw new Error('device_domains must be a list');
    this._config = { show_add: true, ...config };
    this._sig = null;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._loadWeeks();
    else if (this._weeksSig !== this._scheduleSig()) this._loadWeeks();
    this._render();
    this._editor?.onHass();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return 2 + this._visible().length * 2;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  connectedCallback() {
    // "today"/"tomorrow" go stale at midnight; the signature carries the date, so a tick is enough.
    this._clock = setInterval(() => this._render(), 60000);
  }

  disconnectedCallback() {
    clearInterval(this._clock);
    // A dialog removed from the page leaves the top layer without a close event.
    this._editor?.dlg?.close();
    this._editor?.destroy();
  }

  // Which schedule entities changed, cheaply: their last_updated.
  _scheduleSig() {
    return Object.values(this._hass?.states || {})
      .filter((e) => e.entity_id.startsWith('schedule.'))
      .map((e) => `${e.entity_id}@${e.last_updated}`)
      .join('|');
  }

  async _loadWeeks() {
    this._weeksSig = this._scheduleSig();
    const entities = Object.keys(this._hass?.states || {}).filter((id) => id.startsWith('schedule.'));
    if (this._isAdmin) {
      // schedule/list is an admin command, and the only source of what can be edited.
      try {
        this._weeks = await listSchedules(this._h);
      } catch (err) {
        this._weeks ??= {};
        this._weeksError = errorText(err);
      }
      // Which helper each entity is (an entity id can be renamed); asked again only when the set of schedules changes.
      const sig = entities.slice().sort().join('|');
      if (sig !== this._idsSig) {
        this._idsSig = sig;
        this._ids = await scheduleIdsOf(this._h, entities).catch(() => ({}));
      }
    }
    // The rest (YAML schedules, or every schedule for a non-admin) is read-only: get_schedule is open to everyone.
    const rest = entities.filter((id) => !this._weeks?.[this._idOf(id)]);
    try {
      this._readWeeks = await readSchedules(this._h, rest);
    } catch {
      this._readWeeks ??= {};
    }
    this._render(true);
  }

  /** The helper id behind a schedule entity. */
  _idOf(entityId) {
    return this._ids?.[entityId] ?? entityId.slice('schedule.'.length);
  }

  _visible() {
    const c = this._config || {};
    const only = c.entities;
    const hide = c.hide_entities || [];
    return Object.values(this._hass?.states || {})
      .filter((e) => e.entity_id.startsWith('schedule.'))
      .filter((e) => (!only || only.includes(e.entity_id)) && !hide.includes(e.entity_id))
      .sort((a, b) => entityName(a).localeCompare(entityName(b), this._lang));
  }

  _render(force = false) {
    if (!this._config || !this._hass) return;
    const visible = this._visible();
    const sig = JSON.stringify([
      this._lang, this._isAdmin, this._config, new Date().toDateString(), new Date().getHours(),
      visible.map((e) => [e.entity_id, e.last_updated]), !!this._weeks, Object.keys(this._readWeeks || {}).length,
    ]);
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const t = this._t;
    const root = this._root();
    if (!root.querySelector('ha-card')) {
      root.innerHTML = `<style>${BASE_STYLE}${SCHEDULE_STYLE}${EDITOR_STYLE}</style><ha-card><div class="body"></div></ha-card><div class="toast" hidden role="status"></div>`;
      root.addEventListener('click', (e) => this._onClick(e));
      root.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.row[data-id]')) {
          e.preventDefault();
          this._onClick(e);
        }
      });
    }
    const canEdit = this._isAdmin;
    const now = new Date();
    const rows = visible.map((e) => this._rowHtml(e, now, canEdit)).join('');
    this._paint(`
      <div class="header">
        <h2>${esc(this._config.title ?? t.schedules)}</h2>
        ${canEdit && this._config.show_add !== false ? `<button class="btn primary" data-act="new">${esc(t.newSchedule)}</button>` : ''}
      </div>`, `
      ${canEdit ? '' : `<div class="hint">${esc(t.readOnly)}</div>`}
      <div class="list" role="list">${rows || `<div class="hint">${esc(this._weeks || !canEdit ? t.noSchedules : t.loading)}</div>`}</div>`);
  }

  _rowHtml(e, now, canEdit) {
    const t = this._t;
    const id = this._idOf(e.entity_id);
    const editableWeek = this._weeks?.[id];
    const week = editableWeek || this._readWeeks?.[e.entity_id];
    const yaml = e.attributes?.editable === false || (this._weeks && !week);
    const on = e.state === 'on';
    const next = e.attributes?.next_event ? new Date(e.attributes.next_event) : null;
    const editable = canEdit && !yaml && !!editableWeek;
    const when = next && !isNaN(next) ? `${on ? t.ends : t.starts} ${formatWhen(next, now, this._lang)}` : '';
    return `
      <div class="row ${editable ? 'editable' : ''}" role="listitem" ${editable ? `data-id="${esc(e.entity_id)}" tabindex="0"` : ''}
        aria-label="${esc(entityName(e))}">
        <div class="line">
          <span class="dot ${on ? 'on' : ''}" title="${esc(on ? t.onNow : t.offNow)}"></span>
          <span class="name">${esc(entityName(e))}</span>
          <span class="spacer"></span>
          <span class="state ${on ? 'on' : ''}">${esc(on ? t.onNow : t.offNow)}</span>
        </div>
        ${when ? `<div class="when muted small">${esc(when)}</div>` : ''}
        ${yaml ? `<div class="muted small">${esc(t.yaml)}</div>` : ''}
        ${week ? weekBarsHtml(week, this._lang) : ''}
      </div>`;
  }

  _onClick(e) {
    const act = e.target.closest?.('[data-act]')?.dataset.act;
    if (act === 'new') return this._openEditor(null);
    const row = e.target.closest?.('.row[data-id]');
    if (row) this._openEditor(row.dataset.id);
  }

  async _openEditor(entityId) {
    if (!this._isAdmin || this._editor || this._opening) return;
    if (entityId) {
      // The week may have changed elsewhere without touching the entity's state: edit what HA has now.
      this._opening = true;
      try {
        this._weeks = await listSchedules(this._h);
      } catch {
        /* the cached copy will do */
      } finally {
        this._opening = false;
      }
      this._render(true);
      if (!this._weeks?.[this._idOf(entityId)] || this._editor) return;
    }
    this._editor = new ScheduleEditor(this, entityId);
    this._editor.open();
  }

  /** After a write: fresh weeks, whatever the entity states say. */
  _afterWrite() {
    this._loadWeeks();
  }

  /** Areas, devices and the entity registry, for the device picker; read once per card. */
  async _pickerData() {
    this._pickerCache ??= Promise.all([
      this._h.callWS({ type: 'config/area_registry/list' }),
      this._h.callWS({ type: 'config/device_registry/list' }),
      this._h.callWS({ type: 'config/entity_registry/list_for_display' }),
    ]).then(([areas, devices, display]) => ({ areas, devices, display }));
    try {
      return await this._pickerCache;
    } catch (err) {
      this._pickerCache = null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------- the editor dialog


/** Create a schedule for a device, or edit the week of an existing one. Lives in a <dialog> in the card's shadow root. */
class ScheduleEditor {
  constructor(card, entityId) {
    this.card = card;
    this.entityId = entityId; // null = a new schedule
    this.isNew = !entityId;
    this.id = entityId ? card._idOf(entityId) : null;
    this.week = entityId ? card._weeks[this.id].clone() : new WeekSchedule({ name: '' });
    this.originalName = this.week.name;
    this.view = 'main'; // 'picker' | 'confirmDelete'
    this.device = null;
    this.hvacMode = null;
    this.temperature = null;
    this.brightness = null;
    this.turnOffAtEnd = true;
    this.automations = null; // existing schedule: the automations it drives
    this.driven = null; // existing schedule: {automation, config, parsed} for the one automation the card can rewrite
    this.handEdited = false;
    this.rangeEdit = null; // {day, index, chosen: Set} — chosen is used when adding a range
    this.copyFrom = null; // {day, chosen: Set}
    this.query = '';
    this.picker = null;
    this.saving = false;
    this.error = '';
  }

  get t() {
    return this.card._t;
  }

  get lang() {
    return this.card._lang;
  }

  open() {
    const root = this.card._root();
    const dlg = document.createElement('dialog');
    dlg.className = 'editor';
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    root.appendChild(dlg);
    this.dlg = dlg;
    dlg.addEventListener('click', (e) => this.onClick(e));
    dlg.addEventListener('change', (e) => this.onChange(e));
    dlg.addEventListener('input', (e) => this.onInput(e));
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target.id === 'from' || e.target.id === 'to')) {
        e.preventDefault();
        this.dlg.querySelector('[data-act=rangeOk]')?.click();
      }
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.back();
    });
    dlg.addEventListener('close', () => this.destroy());
    this.render();
    dlg.showModal();
    if (this.isNew) {
      this.card._pickerData().then((d) => { this.picker = d; if (this.view === 'picker') this.render(); }, (err) => { this.error = errorText(err); this.render(); });
    } else {
      this.automationsReady = automationsFor(this.card._h, this.entityId).then(
        (a) => { this.automations = a; this.renderLinked(); return this.loadDriven(a); },
        () => { this.automations = []; this.renderLinked(); },
      );
    }
  }

  /** The automation the card wrote for this schedule, if it can be rewritten: then device and action become editable. */
  async loadDriven(automations) {
    const h = this.card._h;
    const ours = [];
    for (const a of automations) {
      const config = await automationConfig(h, a).catch(() => null);
      if (isOurs(config)) ours.push({ automation: a, config, parsed: parseScheduleAutomation(config) });
    }
    this.oursAutomations = ours.map((o) => o.automation);
    const editable = ours.filter((o) => o.parsed && o.parsed.scheduleEntityId === this.entityId);
    if (editable.length === 1) {
      this.driven = editable[0];
      const tgt = this.driven.parsed.target;
      this.device = this.card._hass.states[tgt.entityId] || { entity_id: tgt.entityId, state: 'unavailable', attributes: { friendly_name: tgt.name } };
      this.hvacMode = tgt.hvacMode;
      this.temperature = tgt.temperature;
      this.brightness = tgt.brightnessPct;
      this.turnOffAtEnd = tgt.turnOffAtEnd;
    } else this.handEdited = ours.some((o) => !o.parsed);
    if (this.view === 'main' && (this.driven || this.handEdited)) {
      this.syncName();
      this.render();
    }
  }

  /** What the device section describes now. */
  currentTarget() {
    const d = this.device;
    const keepName = this.driven && this.driven.parsed.target.entityId === d.entity_id;
    return {
      entityId: d.entity_id,
      name: keepName ? this.driven.parsed.target.name : entityName(d),
      hvacMode: domainOf(d.entity_id) === 'climate' ? this.hvacMode : null,
      temperature: this.temperature,
      brightnessPct: this.brightness,
      turnOffAtEnd: this.turnOffAtEnd,
    };
  }

  close() {
    if (this.saving) return; // the result has to be seen
    if (this.dlg?.open) this.dlg.close();
    else this.destroy();
  }

  destroy() {
    this.dlg?.remove();
    if (this.card._editor === this) this.card._editor = null;
  }

  /** Escape or the back arrow: leave a sub-view first, then the dialog. */
  back() {
    if (this.saving) return;
    if (this.view !== 'main') {
      this.view = 'main';
      this.render();
    } else if (this.rangeEdit || this.copyFrom) {
      this.rangeEdit = this.copyFrom = null;
      this.render();
    } else this.close();
  }

  onHass() {
    if (this.view === 'main' && !this.isNew) this.renderLinked();
  }

  // ---- rendering ----

  render() {
    if (!this.dlg) return;
    // What is typed in an open range panel survives a redraw (e.g. the late "What it does" section).
    if (this.rangeEdit && this._panelFor === this.rangeEdit && this.dlg.querySelector('#from')) {
      this.rangeEdit.from = this.dlg.querySelector('#from').value;
      this.rangeEdit.to = this.dlg.querySelector('#to').value;
    }
    const t = this.t;
    const root = this.card._root();
    const focusKey = root.activeElement?.dataset?.focus;
    const scroller = this.dlg.querySelector('.dlg-body');
    const scrollTop = scroller?.scrollTop ?? 0;
    this.dlg.setAttribute('dir', this.card._dirAttr());
    const title = this.view === 'picker' ? t.chooseDevice : this.isNew ? t.newSchedule : t.editSchedule;
    const head = this.view === 'main'
      ? `<button class="icon-btn" data-act="close" aria-label="${esc(t.close)}" data-focus="close" ${this.saving ? 'disabled' : ''}>${icon('close')}</button>
         <h3 id="dlg-title">${esc(title)}</h3>
         ${this.isNew ? '' : `<button class="icon-btn" data-act="askDelete" aria-label="${esc(t.delete)}" title="${esc(t.delete)}" ${this.saving ? 'disabled' : ''}>${icon('delete')}</button>`}
         <button class="btn primary" data-act="save" ${this.saving ? 'disabled' : ''}>${this.saving ? '<span class="spinner"></span>' : ''}${esc(t.save)}</button>`
      : `<button class="icon-btn" data-act="back" aria-label="${esc(t.back)}" data-focus="back">${icon('back', 'flip')}</button><h3 id="dlg-title">${esc(this.view === 'picker' ? title : t.deleteQ)}</h3>`;
    const body = this.view === 'picker' ? this.pickerHtml() : this.view === 'confirmDelete' ? this.confirmHtml() : this.mainHtml();
    this.dlg.innerHTML = `<div class="dlg-head">${head}</div><div class="dlg-body">${body}</div>`;
    const again = this.dlg.querySelector('.dlg-body');
    if (this.view === 'main') again.scrollTop = scrollTop;
    // A panel that just opened (or an error in it) takes the focus and scrolls into view with its day.
    if (this.focusPanel) {
      this.focusPanel = false;
      const panel = this.dlg.querySelector('.panel');
      panel?.closest('.day')?.scrollIntoView({ block: 'nearest' });
      const field = panel?.querySelector('[data-autofocus]');
      field?.focus();
      field?.select?.();
      return;
    }
    const focus = (focusKey && this.dlg.querySelector(`[data-focus="${focusKey}"]`)) || this.dlg.querySelector('[data-autofocus]');
    focus?.focus();
  }

  mainHtml() {
    const t = this.t;
    return `
      ${this.error ? `<div class="error" role="alert"><span>${esc(this.error)}</span></div>` : ''}
      ${this.isNew ? this.targetHtml() : ''}
      <label class="field"><span>${esc(t.name)}</span>
        <input id="name" data-focus="name" value="${esc(this.week.name)}" autocomplete="off"
          ${this.isNew ? `placeholder="${esc(t.namePlaceholder)}"` : ''}></label>
      ${this.isNew ? '' : `<div class="section linked">${this.linkedHtml()}</div>
        ${this.driven ? this.targetHtml(t.whatItDoes) : this.handEdited ? `<div class="muted small">${esc(t.handEdited)}</div>` : ''}`}
      <div class="section">
        <div class="label row-between"><span>${esc(t.hours)}</span>
          <button class="link" data-act="clear" data-focus="clear">${esc(t.clearAll)}</button></div>
        <div class="muted small">${esc(t.midnightHint)}</div>
        <div class="days">${DAYS.map((_, i) => this.dayHtml(i)).join('')}</div>
      </div>`;
  }

  targetHtml(title = this.t.device) {
    const t = this.t;
    const d = this.device;
    let options = '';
    if (d) {
      const o = actionOptions(d);
      if (o.hvacModes.length) {
        options += `<div class="label">${esc(t.whileActive)}</div><div class="chips" role="radiogroup" aria-label="${esc(t.whileActive)}">
          ${o.hvacModes.map((m) => `<button class="choice" role="radio" aria-checked="${this.hvacMode === m}" data-act="hvac" data-v="${esc(m)}"
            data-focus="hvac-${esc(m)}">${esc(t.hvac[m] || m)}</button>`).join('')}</div>`;
      }
      if (o.temp) {
        options += `<div class="opt"><label class="check"><input type="checkbox" data-field="useTemp" data-focus="useTemp" ${this.temperature != null ? 'checked' : ''}>
          <span>${esc(t.setTemp)}</span></label>
          ${this.temperature != null ? `<span class="stepper" dir="ltr">
            <button class="icon-btn" data-act="temp" data-v="-1" aria-label="−" data-focus="temp-">${icon('minus')}</button>
            <b aria-live="polite">${esc(this.temperature)}°</b>
            <button class="icon-btn" data-act="temp" data-v="1" aria-label="+" data-focus="temp+">${icon('plus')}</button></span>` : ''}</div>`;
      }
      if (o.brightness) {
        options += `<div class="opt"><label class="check"><input type="checkbox" data-field="useBrightness" data-focus="useBrightness" ${this.brightness != null ? 'checked' : ''}>
          <span>${esc(t.brightness)}</span></label>
          ${this.brightness != null ? `<input type="range" min="1" max="100" value="${this.brightness}" data-field="brightness" data-focus="brightness"
            aria-label="${esc(t.brightness)}"><b class="bval">${this.brightness}%</b>` : ''}</div>`;
      }
      options += `<div class="muted small summary">${esc(actionSummary(this.currentTarget(), this.lang))}</div>`;
      options += `<div class="opt"><span>${esc(o.domain === 'cover' ? t.closeAtEnd : t.turnOffAtEnd)}</span><span class="spacer"></span>
        ${switchHtml({ checked: this.turnOffAtEnd, label: o.domain === 'cover' ? t.closeAtEnd : t.turnOffAtEnd, attrs: 'data-field="turnOff" data-focus="turnOff"' })}</div>`;
    }
    return `<div class="section">
      <div class="label">${esc(title)}</div>
      <button class="device" data-act="pick" data-focus="pick">
        ${d ? `<span class="dname">${esc(entityName(d))}</span><span class="muted small" dir="ltr">${esc(d.entity_id)}</span><span class="spacer"></span><span class="link">${esc(t.changeDevice)}</span>`
          : `<span>${esc(t.chooseDevice)}</span>`}
      </button>
      ${options}
    </div>`;
  }

  linkedHtml() {
    const t = this.t;
    const autos = this.automations;
    const states = this.card._hass.states;
    let inner;
    if (autos === null) inner = `<div class="muted small">${esc(t.loading)}</div>`;
    else if (!autos.length) inner = `<div class="warn"><span>${esc(t.drivesNothing)}</span></div>`;
    else {
      inner = autos.map((a) => {
        const on = states[a]?.state === 'on';
        return `<div class="opt"><div class="grow"><div>${esc(entityName(states[a]) || a)}</div>
          <div class="muted small">${esc(on ? t.autoOn : t.autoOff)}</div></div>
          ${switchHtml({ checked: on, label: entityName(states[a]) || a, attrs: `data-field="auto" data-id="${esc(a)}" data-focus="auto-${esc(a)}"` })}</div>`;
      }).join('');
    }
    return `<div class="label">${esc(t.drives)}</div>${inner}`;
  }

  renderLinked() {
    const el = this.dlg?.querySelector('.linked');
    if (!el) return;
    const sig = JSON.stringify([this.automations, (this.automations || []).map((a) => this.card._hass.states[a]?.state)]);
    if (sig === this._linkedSig) return;
    this._linkedSig = sig;
    const focusKey = this.card._root().activeElement?.dataset?.focus;
    el.innerHTML = this.linkedHtml();
    if (focusKey) el.querySelector(`[data-focus="${focusKey}"]`)?.focus();
  }

  dayHtml(i) {
    const t = this.t;
    const name = DAY_NAMES[this.lang][i];
    const blocks = this.week.days[DAYS[i]];
    const chips = blocks.map((b, k) => `<span class="range"><button data-act="edit" data-day="${i}" data-index="${k}" dir="ltr"
        aria-label="${esc(`${t.editRange} ${name} ${blockLabel(b)}`)}" data-focus="edit-${i}-${k}">${esc(blockLabel(b))}</button><button
        class="x" data-act="remove" data-day="${i}" data-index="${k}" aria-label="${esc(`${t.removeRange} ${blockLabel(b)}`)}">${icon('close')}</button></span>`).join('');
    let panel = '';
    if (this.rangeEdit?.day === i) {
      this._panelFor = this.rangeEdit;
      const b = this.rangeEdit.index != null ? blocks[this.rangeEdit.index] : { start: 8 * 60, end: 9 * 60 };
      panel = `<div class="panel" role="group" aria-label="${esc(t.editRange)}">
        <div class="times" dir="ltr">
          <label><span>${esc(t.from)}</span><input type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" id="from" data-focus="from"
            value="${esc(this.rangeEdit.from ?? hm(b.start))}" data-autofocus></label>
          <span aria-hidden="true">–</span>
          <label><span>${esc(t.to)}</span><input type="text" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="HH:MM" id="to" data-focus="to"
            value="${esc(this.rangeEdit.to ?? hm(b.end))}"></label>
        </div>
        ${this.rangeEdit.index == null ? `<div class="label">${esc(t.rangeDays)}</div>
          <div class="chips"><button class="choice" data-act="rangePreset" data-v="weekdays" aria-pressed="${[1, 2, 3, 4, 5].every((k) => this.rangeEdit.chosen.has(k)) && this.rangeEdit.chosen.size === 5}">${esc(t.weekdays)}</button>
            <button class="choice" data-act="rangePreset" data-v="week" aria-pressed="${this.rangeEdit.chosen.size === 7}">${esc(t.everyDay)}</button></div>
          <div class="copy-days">${DAYS.map((_, k) => `<label class="check"><input type="checkbox" data-field="rangeDay" data-v="${k}" ${this.rangeEdit.chosen.has(k) ? 'checked' : ''}>
            <span>${esc(DAY_NAMES[this.lang][k])}</span></label>`).join('')}</div>` : ''}
        ${this.rangeEdit.error ? `<div class="error small" role="alert">${esc(this.rangeEdit.error)}</div>` : ''}
        <div class="actions"><button class="btn" data-act="rangeCancel">${esc(t.cancel)}</button><button class="btn primary" data-act="rangeOk">${esc(t.ok)}</button></div>
      </div>`;
    } else if (this.copyFrom?.day === i) {
      const chosen = this.copyFrom.chosen;
      panel = `<div class="panel" role="group" aria-label="${esc(t.copyTo(name))}">
        <div class="label">${esc(t.copyTo(name))}</div>
        <div class="chips"><button class="choice" data-act="copyPreset" data-v="weekdays" data-autofocus>${esc(t.weekdays)}</button>
          <button class="choice" data-act="copyPreset" data-v="week">${esc(t.wholeWeek)}</button></div>
        <div class="copy-days">${DAYS.map((_, k) => (k === i ? '' : `<label class="check"><input type="checkbox" data-field="copyDay" data-v="${k}" ${chosen.has(k) ? 'checked' : ''}>
          <span>${esc(DAY_NAMES[this.lang][k])}</span></label>`)).join('')}</div>
        <div class="actions"><button class="btn" data-act="copyCancel">${esc(t.cancel)}</button><button class="btn primary" data-act="copyOk">${esc(t.copy)}</button></div>
      </div>`;
    }
    return `<div class="day">
      <div class="day-line">
        <span class="dname">${esc(name)}</span>
        <div class="ranges">${chips}<button class="add" data-act="add" data-day="${i}" data-focus="add-${i}" aria-label="${esc(`${t.addRange} ${name}`)}">+ ${esc(t.addRange)}</button></div>
        ${blocks.length ? `<button class="icon-btn" data-act="copyOpen" data-day="${i}" aria-label="${esc(`${t.copyDays} (${name})`)}" title="${esc(t.copyDays)}" data-focus="copy-${i}">${icon('copy')}</button>` : '<span class="icon-space"></span>'}
      </div>
      ${panel}
    </div>`;
  }

  pickerHtml() {
    const t = this.t;
    if (!this.picker) return `<div class="muted">${esc(t.loading)}</div>`;
    // A chip per device type this house has (within the card's device_domains).
    const present = new Set(deviceSections(this.pickerData()).flatMap((sec) => sec.entities.map((e) => domainOf(e.entity_id))));
    const types = PICKABLE_DOMAINS.filter((d) => present.has(d));
    const chip = (v, label) => `<button class="choice" role="radio" aria-checked="${(this.domainFilter ?? null) === v}" data-act="domain"
      data-v="${esc(v ?? '')}" data-focus="domain-${esc(v ?? 'all')}">${esc(label)}</button>`;
    return `<div class="picker-top"><label class="search"><input type="search" id="q" data-focus="q" data-autofocus placeholder="${esc(t.searchDevice)}"
      aria-label="${esc(t.searchDevice)}" value="${esc(this.query)}"></label>
      ${types.length > 1 ? `<div class="chips types" role="radiogroup" aria-label="${esc(t.device)}">${chip(null, t.allTypes)}${types.map((d) => chip(d, t.domainName[d] || d)).join('')}</div>` : ''}</div>
      <div class="picker-list">${this.pickerListHtml()}</div>`;
  }

  pickerData(only = null) {
    return { states: this.card._hass.states, ...this.picker, domains: this.card._config.device_domains, only };
  }

  pickerListHtml() {
    const t = this.t;
    const sections = deviceSections(this.pickerData(this.domainFilter), this.query, t.noArea, this.lang);
    if (!sections.length) return `<div class="muted">${esc(t.noDevices)}</div>`;
    return sections.map((sec) => `<div class="area">${esc(sec.title)}</div>${sec.entities.map((e) => `
      <button class="pick" data-act="choose" data-id="${esc(e.entity_id)}"><span class="grow">${esc(entityName(e))}</span>
        <span class="muted small" dir="ltr">${esc(e.entity_id)}</span></button>`).join('')}`).join('');
  }

  confirmHtml() {
    const t = this.t;
    return `<p>${esc(t.deleteText)}</p>
      ${this.error ? `<div class="error" role="alert"><span>${esc(this.error)}</span></div>` : ''}
      <div class="actions"><button class="btn" data-act="back" ${this.saving ? 'disabled' : ''}>${esc(t.cancel)}</button>
        <button class="btn primary danger-fill" data-act="doDelete" data-autofocus ${this.saving ? 'disabled' : ''}>${this.saving ? '<span class="spinner"></span>' : ''}${esc(t.delete)}</button></div>`;
  }

  // ---- events ----

  onClick(e) {
    if (e.target === this.dlg) return; // the backdrop: keep what was typed
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    const day = el.dataset.day != null ? Number(el.dataset.day) : null;
    const index = el.dataset.index != null ? Number(el.dataset.index) : null;
    const w = this.week;
    switch (act) {
      case 'close': return this.close();
      case 'back': return this.back();
      case 'save': return this.save();
      case 'askDelete': this.view = 'confirmDelete'; this.error = ''; break;
      case 'doDelete': return this.remove();
      case 'pick':
        this.view = 'picker';
        this.query = '';
        if (!this.picker) {
          this.card._pickerData().then((d) => { this.picker = d; if (this.view === 'picker') this.render(); }, (err) => { this.error = errorText(err); this.view = 'main'; this.render(); });
        }
        break;
      case 'choose': {
        const d = this.card._hass.states[el.dataset.id];
        if (!d) return;
        this.device = d;
        const o = actionOptions(d);
        this.hvacMode = o.defaultHvac;
        this.temperature = null;
        this.brightness = null;
        if (!this.nameInput().trim()) this.week.name = entityName(d);
        this.view = 'main';
        break;
      }
      case 'hvac': this.hvacMode = el.dataset.v; break;
      case 'domain': this.domainFilter = el.dataset.v || null; break;
      case 'temp': {
        const o = actionOptions(this.device);
        const step = o.temp.step;
        const next = Math.round((this.temperature + Number(el.dataset.v) * step) / step) * step;
        this.temperature = Math.min(o.temp.max, Math.max(o.temp.min, Number(next.toFixed(1))));
        break;
      }
      case 'clear': for (const d of DAYS) w.days[d] = []; this.rangeEdit = this.copyFrom = null; break;
      case 'add': this.rangeEdit = { day, index: null, chosen: new Set([day]) }; this.copyFrom = null; this.focusPanel = true; break;
      case 'edit': this.rangeEdit = { day, index }; this.copyFrom = null; this.focusPanel = true; break;
      case 'remove': w.days[DAYS[day]] = w.days[DAYS[day]].filter((_, k) => k !== index); this.rangeEdit = null; break;
      case 'rangeCancel': this.rangeEdit = null; break;
      case 'rangePreset': {
        this.rangeEdit.chosen = new Set(el.dataset.v === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]);
        break;
      }
      case 'rangeOk': {
        const from = this.dlg.querySelector('#from').value;
        const to = this.dlg.querySelector('#to').value;
        Object.assign(this.rangeEdit, { from, to }); // kept if the panel is drawn again with an error
        const start = parseTimeInput(from);
        let end = parseTimeInput(to);
        if (end === 0) end = 1440; // "until midnight"
        if (start == null || end == null || start >= 1440) {
          this.rangeEdit.error = this.t.errTime;
          this.focusPanel = true;
          break;
        }
        if (end <= start) {
          this.rangeEdit.error = this.t.errRange;
          this.focusPanel = true;
          break;
        }
        const chosen = this.rangeEdit.index == null ? [...this.rangeEdit.chosen] : [this.rangeEdit.day];
        if (!chosen.length) {
          this.rangeEdit.error = this.t.rangeDays;
          break;
        }
        const conflict = chosen.find((k) => w.days[DAYS[k]].some((b, i) => i !== (k === this.rangeEdit.day ? this.rangeEdit.index : null) && start < b.end && end > b.start));
        if (conflict !== undefined) {
          this.rangeEdit.error = this.t.errOverlap(DAY_NAMES[this.lang][conflict]);
          break;
        }
        for (const k of chosen) {
          const d = DAYS[k];
          const old = this.rangeEdit.index != null ? w.days[d][this.rangeEdit.index] : null;
          const next = w.days[d].filter((_, i) => i !== (k === this.rangeEdit.day ? this.rangeEdit.index : null));
          next.push({ ...(old?.data ? { data: old.data } : {}), start, end });
          w.days[d] = next.sort(byStart);
        }
        this.rangeEdit = null;
        break;
      }
      case 'copyOpen': this.copyFrom = { day, chosen: new Set() }; this.rangeEdit = null; this.focusPanel = true; break;
      case 'copyPreset': this.copyFrom.chosen = new Set(el.dataset.v === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]); break;
      case 'copyCancel': this.copyFrom = null; break;
      case 'copyOk': {
        const from = w.days[DAYS[this.copyFrom.day]];
        for (const k of this.copyFrom.chosen) if (k !== this.copyFrom.day) w.days[DAYS[k]] = from.map((b) => ({ ...b }));
        this.copyFrom = null;
        break;
      }
      default: return;
    }
    this.syncName();
    this.render();
  }

  onChange(e) {
    const f = e.target.dataset?.field;
    if (!f) return;
    if (f === 'auto') {
      const id = e.target.dataset.id;
      // Back to what HA says, whether the call worked or not.
      this.card._run(() => setAutomationEnabled(this.card._h, id, e.target.checked)).then(() => {
        this._linkedSig = null;
        this.renderLinked();
      });
      return;
    }
    if (f === 'copyDay') {
      const k = Number(e.target.dataset.v);
      e.target.checked ? this.copyFrom.chosen.add(k) : this.copyFrom.chosen.delete(k);
      return;
    }
    if (f === 'rangeDay') {
      const k = Number(e.target.dataset.v);
      e.target.checked ? this.rangeEdit.chosen.add(k) : this.rangeEdit.chosen.delete(k);
      return;
    }
    if (f === 'useTemp') this.temperature = e.target.checked ? actionOptions(this.device).temp.initial : null;
    else if (f === 'useBrightness') this.brightness = e.target.checked ? 80 : null;
    else if (f === 'turnOff') this.turnOffAtEnd = e.target.checked;
    else if (f === 'brightness') this.brightness = Number(e.target.value);
    else return;
    this.syncName();
    this.render();
  }

  onInput(e) {
    if (e.target.id === 'name') this.week.name = e.target.value;
    else if (e.target.id === 'q') {
      this.query = e.target.value;
      this.dlg.querySelector('.picker-list').innerHTML = this.pickerListHtml();
    } else if (e.target.dataset?.field === 'brightness') {
      this.brightness = Number(e.target.value);
      const b = this.dlg.querySelector('.bval');
      if (b) b.textContent = `${this.brightness}%`;
    }
  }

  nameInput() {
    return this.dlg.querySelector('#name')?.value ?? this.week.name;
  }

  syncName() {
    const el = this.dlg?.querySelector('#name');
    if (el) this.week.name = el.value;
  }

  // ---- writes ----

  async save() {
    const t = this.t;
    this.syncName();
    const problem = this.week.validate(this.lang) ?? (this.week.isEmpty ? t.errEmpty : null) ?? (this.isNew && !this.device ? t.errDevice : null);
    if (problem) {
      this.error = problem;
      this.render();
      this.dlg.querySelector('.dlg-body').scrollTop = 0;
      return;
    }
    this.error = '';
    this.saving = true;
    this.rangeEdit = this.copyFrom = null;
    this.render();
    const h = this.card._h;
    try {
      if (this.isNew) {
        await createScheduleWithAutomation(h, this.week, this.currentTarget());
      } else {
        await this.automationsReady; // rename needs the linked automations
        await updateSchedule(h, this.id, this.week);
        if (this.driven) {
          // The alias follows the new name only while it is still the one the card gave it; renameScheduleAutomations decides.
          const followsName = this.driven.config.alias === scheduleAlias(this.originalName.trim());
          await rewriteScheduleAutomation(h, this.driven.config, {
            scheduleName: followsName ? this.week.name : undefined,
            target: this.currentTarget(),
          });
        }
        await renameScheduleAutomations(h, this.automations || [], this.originalName, this.week.name);
      }
      this.saving = false;
      this.card._afterWrite();
      this.close();
      this.card._toast(this.isNew ? t.created : t.saved, 3000);
    } catch (err) {
      this.saving = false;
      this.error = t.saveFailed(errorText(err));
      if (!this.dlg?.isConnected) return this.card._toast(this.error, 12000); // closed meanwhile (e.g. Escape twice)
      this.render();
      this.dlg.querySelector('.dlg-body').scrollTop = 0;
    }
  }

  async remove() {
    const t = this.t;
    this.saving = true;
    this.render();
    try {
      const kept = await deleteSchedule(this.card._h, this.entityId, this.id);
      this.saving = false;
      this.card._afterWrite();
      this.close();
      if (kept.length) this.card._toast(t.kept(kept.join(', ')), 12000);
    } catch (err) {
      this.saving = false;
      this.error = t.deleteFailed(errorText(err));
      if (!this.dlg?.isConnected) return this.card._toast(this.error, 12000);
      this.render();
    }
  }
}

const EDITOR_STYLE = `
  dialog.editor { padding: 0; border: 0; border-radius: var(--ha-card-border-radius, 12px); width: min(640px, calc(100vw - 32px));
    max-height: calc(100vh - 48px); background: var(--card-background-color, #fff); color: var(--primary-text-color);
    box-shadow: 0 8px 32px rgba(0,0,0,.35); overflow: hidden; }
  dialog.editor[open] { display: flex; flex-direction: column; }
  dialog.editor::backdrop { background: rgba(0,0,0,.5); }
  @media (max-width: 600px) {
    dialog.editor { width: 100vw; max-width: 100vw; height: 100vh; height: 100dvh; max-height: 100dvh; border-radius: 0; margin: 0; }
  }
  .dlg-head { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--divider-color); flex: none; }
  .dlg-head h3 { flex: 1; margin: 0 4px; font-size: 18px; font-weight: 500; }
  .dlg-body { overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; overscroll-behavior: contain; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field span, .label { font-size: 13px; color: var(--secondary-text-color); font-weight: 500; }
  .field input, .search input, .times input { font: inherit; color: inherit; padding: 9px 12px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color, transparent); }
  .field input { font-size: 16px; }
  .section { display: flex; flex-direction: column; gap: 8px; }
  .row-between { display: flex; align-items: center; justify-content: space-between; }
  .link { font: inherit; font-size: 13px; color: var(--primary-color); background: none; border: 0; padding: 0; cursor: pointer; }
  .seg { display: inline-flex; align-self: flex-start; border: 1px solid var(--divider-color); border-radius: 18px; overflow: hidden; }
  .seg button { display: inline-flex; gap: 4px; align-items: center; padding: 7px 16px; border: 0; background: transparent; cursor: pointer; font-size: 14px; }
  .seg button + button { border-inline-start: 1px solid var(--divider-color); }
  .seg button[aria-checked="true"] { background: color-mix(in srgb, var(--primary-color) 20%, transparent); font-weight: 600; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .choice { padding: 6px 14px; border-radius: 16px; border: 1px solid var(--divider-color); background: transparent; cursor: pointer; font-size: 14px; }
  .choice[aria-checked="true"] { background: color-mix(in srgb, var(--primary-color) 20%, transparent); border-color: var(--primary-color); font-weight: 600; }
  .device { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border-radius: 8px; cursor: pointer; text-align: start;
    border: 1px dashed var(--divider-color); background: transparent; color: var(--primary-color); font-size: 14px; }
  .device .dname { color: var(--primary-text-color); font-weight: 500; }
  .opt { display: flex; align-items: center; gap: 8px; min-height: 40px; }
  .summary { padding: 2px 0; }
  .opt input[type=range] { flex: 1; accent-color: var(--primary-color); }
  .grow, .spacer { flex: 1; min-width: 0; }
  .check { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; }
  .check input { width: 18px; height: 18px; accent-color: var(--primary-color); margin: 0; }
  .stepper { display: inline-flex; align-items: center; gap: 2px; margin-inline-start: auto; }
  .stepper b { min-width: 40px; text-align: center; font-size: 16px; }
  .warn, .error { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
  .warn { background: color-mix(in srgb, var(--warning-color, #ffa600) 16%, transparent); }
  .error { background: color-mix(in srgb, var(--error-color, #db4437) 14%, transparent); color: var(--error-color, #db4437); }
  .error.small { padding: 4px 8px; font-size: 13px; }
  .days { display: flex; flex-direction: column; }
  .day { border-bottom: 1px solid var(--divider-color); padding: 6px 0; }
  .day:last-child { border-bottom: 0; }
  .day-line { display: flex; align-items: center; gap: 8px; }
  .day-line .dname { width: 52px; flex: none; font-size: 14px; }
  dialog.editor[dir=ltr] .day-line .dname { width: 88px; } /* "Wednesday" */
  .ranges { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .range { display: inline-flex; align-items: center; border-radius: 16px; background: color-mix(in srgb, var(--primary-color) 16%, transparent); }
  .range button { border: 0; background: transparent; cursor: pointer; padding: 5px 4px 5px 12px; font-size: 14px; font-variant-numeric: tabular-nums; }
  .range .x { padding: 4px 8px 4px 2px; display: inline-flex; color: var(--secondary-text-color); }
  .range .x .ic { width: 16px; height: 16px; }
  .add { display: inline-flex; align-items: center; gap: 2px; padding: 4px 10px 4px 6px; border-radius: 16px; font-size: 13px; cursor: pointer;
    border: 1px dashed var(--divider-color); background: transparent; color: var(--primary-color); }
  .add .ic { width: 16px; height: 16px; }
  .icon-space { width: 36px; flex: none; }
  .panel { margin: 8px 0 4px; padding: 12px; border-radius: 10px; background: var(--secondary-background-color, rgba(127,127,127,.1));
    display: flex; flex-direction: column; gap: 10px; }
  .times { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
  .times label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--secondary-text-color); }
  .times input { font-size: 16px; color: var(--primary-text-color); background: var(--card-background-color); width: 6.5em;
    text-align: center; font-variant-numeric: tabular-nums; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  .copy-days { display: flex; flex-wrap: wrap; gap: 6px 16px; }
  .picker-top { position: sticky; top: -16px; background: var(--card-background-color); padding: 4px 0 8px; z-index: 1; display: flex; flex-direction: column; gap: 8px; }
  .search { display: flex; align-items: center; gap: 8px; background: var(--card-background-color); }
  .picker-top .search { padding: 0; }
  .chips.types { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }
  .chips.types .choice { white-space: nowrap; font-size: 13px; padding: 4px 12px; }
  .search input { flex: 1; font-size: 16px; }
  .search .ic { color: var(--secondary-text-color); }
  .picker-list { display: flex; flex-direction: column; }
  .area { font-size: 13px; font-weight: 600; color: var(--secondary-text-color); padding: 12px 4px 4px; }
  .pick { display: flex; align-items: center; gap: 8px; padding: 10px 8px; border: 0; border-radius: 8px; background: transparent; cursor: pointer; text-align: start; font-size: 15px; }
  .pick:hover { background: color-mix(in srgb, var(--primary-color) 8%, transparent); }
  .btn.danger-fill, .btn.danger-fill:hover { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
  .spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

/** Seven thin bars, one per day, Sunday first; the time axis always runs left to right. */
function weekBarsHtml(week, lang) {
  const names = DAY_NAMES[lang];
  return `<div class="bars" dir="ltr">${DAYS.map((d, i) => `
    <div class="bar-row" title="${esc(names[i])}: ${esc(week.days[d].map(blockLabel).join(', ') || '—')}">
      <span class="bar-day">${esc(DAY_SHORT[lang][i])}</span>
      <span class="bar">${week.days[d].map((b) => `<i style="left:${(b.start / 14.4).toFixed(2)}%;width:${((b.end - b.start) / 14.4).toFixed(2)}%"></i>`).join('')}</span>
    </div>`).join('')}</div>`;
}

const SCHEDULE_STYLE = `
  .list { padding: 0 8px 8px; }
  .row { padding: 10px 8px; border-top: 1px solid var(--divider-color); border-radius: 8px; }
  .row:first-child { border-top: 0; }
  .row.editable { cursor: pointer; }
  .row.editable:hover { background: color-mix(in srgb, var(--primary-color) 6%, transparent); }
  .line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name { font-size: 15px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .spacer { flex: 1; }
  .state { font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
  .state.on { color: var(--success-color, #43a047); font-weight: 500; }
  .when { margin: 2px 16px 0; }
  .bars { margin: 8px 16px 0; display: flex; flex-direction: column; gap: 3px; }
  .bar-row { display: flex; align-items: center; gap: 6px; }
  .bar-day { width: 16px; font-size: 10px; color: var(--secondary-text-color); text-align: center; flex: none; }
  .bar { position: relative; flex: 1; height: 5px; border-radius: 3px; background: color-mix(in srgb, var(--divider-color) 70%, transparent); overflow: hidden; }
  .bar i { position: absolute; top: 0; bottom: 0; background: var(--primary-color); border-radius: 3px; }
`;

// ---------------------------------------------------------------------------- visual config editors

/** HA echoes our own config-changed back through setConfig; re-rendering then would steal focus. */
class EditorBase extends Base {
  setConfig(config) {
    if (this._emitted && JSON.stringify(config) === this._emitted) return;
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._render();
      this._loadDash();
    }
  }

  get _t() {
    return STRINGS[langOf(this._hass)];
  }

  // ---- "Create the Schedule Helper dashboard" ----

  async _loadDash() {
    if (this._hass?.user?.is_admin === false) return;
    try {
      this._dash = { existing: await findDashboard(this._hass) };
    } catch {
      this._dash = null; // no dashboards API here (e.g. YAML mode): no section
    }
    this._renderDash();
  }

  async _createDash() {
    this._dash = { ...this._dash, busy: true, error: null };
    this._renderDash();
    try {
      const r = await createDashboard(this._hass);
      this._dash = { existing: r, created: r.created };
    } catch (err) {
      this._dash = { ...this._dash, busy: false, error: errorText(err) };
    }
    this._renderDash();
  }

  _renderDash() {
    const el = this.shadowRoot?.querySelector('[data-dash]');
    if (!el) return;
    const t = this._t;
    const d = this._dash;
    if (!d || this._hass?.user?.is_admin === false) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const href = `/${d.existing?.url_path || DASHBOARD.url_path}`;
    el.innerHTML = `<h3>${esc(t.edDashboard)}</h3>
      ${d.existing
        ? `<p class="hint">${esc(d.created ? t.edDashboardCreated : t.edDashboardExists)} <a href="${esc(href)}" target="_top">${esc(t.edDashboardOpen)}</a></p>`
        : `<p class="hint">${esc(t.edDashboardHint)}</p>
           <div><button class="make" data-act="makeDash" ${d.busy ? 'disabled' : ''}>${esc(t.edDashboardCreate)}</button></div>`}
      ${d.error ? `<p class="err" role="alert">${esc(d.error)}</p>` : ''}`;
    el.querySelector('[data-act=makeDash]')?.addEventListener('click', () => this._createDash());
  }

  _emit(config) {
    for (const [k, v] of Object.entries(config)) {
      if (v === '' || v === undefined || (Array.isArray(v) && !v.length)) delete config[k];
    }
    this._config = config;
    this._emitted = JSON.stringify(config);
    this.dispatchEvent(new CustomEvent('config-changed', { detail: { config }, bubbles: true, composed: true }));
  }

  _shell(inner) {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>${CONFIG_EDITOR_STYLE}</style><div class="ed" dir="${langOf(this._hass) === 'he' ? 'rtl' : 'ltr'}">
      <section data-dash class="dash" hidden></section>${inner}</div>`;
    this._renderDash();
    return this.shadowRoot;
  }
}

class ScheduleHelperCardEditor extends EditorBase {
  _render() {
    if (!this._config) return;
    const t = this._t;
    const c = this._config;
    const schedules = Object.values(this._hass?.states || {})
      .filter((e) => e.entity_id.startsWith('schedule.'))
      .sort((a, b) => entityName(a).localeCompare(entityName(b), langOf(this._hass)));
    const whitelist = Array.isArray(c.entities);
    const shown = (id) => (whitelist ? c.entities.includes(id) : !(c.hide_entities || []).includes(id));
    const root = this._shell(`
      <section>
        <h3>${esc(t.edGeneral)}</h3>
        <label class="field"><span>${esc(t.edTitle)}</span><input data-key="title" value="${esc(c.title ?? '')}" placeholder="${esc(t.schedules)}"></label>
        <label class="field"><span>${esc(t.edHeight)}</span><input data-key="height" value="${esc(c.height ?? '')}" placeholder="${esc(t.edHeightHint)}"></label>
        <label class="chk"><input type="checkbox" data-bool="show_add" ${c.show_add !== false ? 'checked' : ''}><span>${esc(t.edShowAdd)}</span></label>
      </section>
      <section>
        <h3>${esc(t.edDeviceDomains)}</h3>
        <p class="hint">${esc(t.edDeviceDomainsHint)}</p>
        <div class="types">${PICKABLE_DOMAINS.map((d) => `<label class="chk"><input type="checkbox" data-domain="${esc(d)}"
          ${!c.device_domains?.length || c.device_domains.includes(d) ? 'checked' : ''}><span>${esc(t.domainName[d])}</span></label>`).join('')}</div>
      </section>
      <section>
        <h3>${esc(t.edSchedules)}</h3>
        <p class="hint">${esc(t.edSchedulesHint)}</p>
        <div class="actions"><button data-all>${esc(t.edAll)}</button><button data-none>${esc(t.edNone)}</button></div>
        <div class="list">${schedules.map((e) => `<label class="chk row"><input type="checkbox" data-schedule="${esc(e.entity_id)}" ${shown(e.entity_id) ? 'checked' : ''}>
          <span>${esc(entityName(e))}</span><small dir="ltr">${esc(e.entity_id)}</small></label>`).join('') || `<div class="hint">${esc(t.noSchedules)}</div>`}</div>
      </section>`);
    root.querySelectorAll('[data-key]').forEach((el) => el.addEventListener('change', () => this._emit({ ...this._config, [el.dataset.key]: el.value.trim() })));
    root.querySelectorAll('[data-bool]').forEach((el) => el.addEventListener('change', () => {
      const config = { ...this._config, [el.dataset.bool]: el.checked };
      if (el.checked) delete config[el.dataset.bool]; // both default to true
      this._emit(config);
    }));
    root.querySelector('.list').addEventListener('change', () => this._saveSchedules());
    root.querySelector('.types').addEventListener('change', () => {
      const ticked = [...root.querySelectorAll('[data-domain]')].filter((b) => b.checked).map((b) => b.dataset.domain);
      const config = { ...this._config, device_domains: ticked };
      if (ticked.length === PICKABLE_DOMAINS.length) delete config.device_domains; // all is the default
      this._emit(config);
    });
    root.querySelector('[data-all]').addEventListener('click', () => this._setAll(true));
    root.querySelector('[data-none]').addEventListener('click', () => this._setAll(false));
  }

  _setAll(on) {
    this.shadowRoot.querySelectorAll('[data-schedule]').forEach((b) => (b.checked = on));
    this._saveSchedules();
  }

  _saveSchedules() {
    const boxes = [...this.shadowRoot.querySelectorAll('[data-schedule]')];
    const config = { ...this._config };
    if (Array.isArray(config.entities)) config.entities = boxes.filter((b) => b.checked).map((b) => b.dataset.schedule);
    else config.hide_entities = boxes.filter((b) => !b.checked).map((b) => b.dataset.schedule);
    this._emit(config);
  }
}

const CONFIG_EDITOR_STYLE = `
  .ed { display: flex; flex-direction: column; gap: 18px; color: var(--primary-text-color); font-size: 14px; }
  section { display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .hint, small { color: var(--secondary-text-color); font-size: 12px; margin: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field span { font-size: 12px; color: var(--secondary-text-color); }
  .field input, .field select { font: inherit; color: inherit; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--divider-color);
    background: var(--card-background-color, transparent); }
  .chk { display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .chk input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary-color); flex: none; }
  .chk span { flex: 1; min-width: 0; }
  .list { display: flex; flex-direction: column; max-height: 280px; overflow-y: auto; border: 1px solid var(--divider-color); border-radius: 10px; }
  .row { padding: 7px 10px; border-bottom: 1px solid var(--divider-color); }
  .row:last-child { border-bottom: 0; }
  .dash { padding: 12px; border-radius: 10px; background: color-mix(in srgb, var(--primary-color) 8%, transparent); }
  .make { font: inherit; font-size: 14px; font-weight: 500; padding: 7px 14px; border-radius: 18px; cursor: pointer;
    border: 0; background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .make:disabled { opacity: .5; cursor: default; }
  .hint a { color: var(--primary-color); }
  .err { color: var(--error-color, #db4437); font-size: 13px; margin: 0; }
  .types { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px; }
  .actions { display: flex; gap: 12px; }
  .actions button { font: inherit; font-size: 12px; color: var(--primary-color); background: none; border: 0; padding: 0; cursor: pointer; }
`;

export { ScheduleHelperCardEditor };

export { ScheduleHelperCard, CardBase };

if (typeof customElements !== 'undefined') {
  console.info(`%c SCHEDULE-HELPER-CARD %c ${VERSION} `, 'background:#03a9f4;color:#fff;font-weight:600', 'background:#333;color:#fff');
  const define = (name, cls) => {
    if (!customElements.get(name)) customElements.define(name, cls);
  };
  define('schedule-helper-card', ScheduleHelperCard);
  define('schedule-helper-card-editor', ScheduleHelperCardEditor);
  // The schedule-card name before 2.0 still works.
  define('beit-schedule-card', class extends ScheduleHelperCard {});
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === 'schedule-helper-card')) {
    window.customCards.push({
      type: 'schedule-helper-card',
      name: 'Schedule Helper Card',
      description: 'Weekly schedules for Home Assistant devices.',
      preview: false,
    });
  }
}
