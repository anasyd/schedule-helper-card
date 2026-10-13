// The HA operations, run against the in-memory fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeHass, slugify } from './fake-hass.mjs';
import {
  WeekSchedule, listSchedules, createScheduleWithAutomation, updateSchedule, deleteSchedule, automationsFor,
  setAutomationEnabled, isOurs, weekStatus, errorText,
} from '../dist/schedule-helper-card.js';

const NAMES = ['states', 'schedule_list', 'automation_configs', 'label_registry', 'entity_registry_display', 'area_registry', 'device_registry', 'yaml_schedules'];
export const fixtures = Object.fromEntries(NAMES.map((n) => [n, JSON.parse(readFileSync(new URL(`fixtures/${n}.json`, import.meta.url)))]));
// A Sunday morning, local time.
const SUNDAY_9AM = () => new Date(2026, 0, 4, 9, 0, 0);
const house = (opts = {}) => new FakeHass(fixtures, { now: SUNDAY_9AM, ...opts });
const FAST = { waitOptions: { tries: 20, every: 5 } };

const week = (name, days) => new WeekSchedule({ name, days });
const writes = (hass) => hass.calls.filter((c) => !['schedule/list', 'search/related', 'automation/config', 'config/label_registry/list',
  'config/entity_registry/list_for_display', 'config/area_registry/list', 'config/device_registry/list', 'config/entity_registry/get'].includes(c.type) && c.method !== 'GET');

// ---- schedules -----------------------------------------------------------------------------------------------------

test('listSchedules returns every UI schedule, not the YAML one', async () => {
  const hass = house();
  const all = await listSchedules(hass);
  assert.equal(Object.keys(all).length, 6);
  assert.ok(!('pool_pump' in all));
  assert.ok(hass.states['schedule.pool_pump']);
  assert.equal(all.balcony_light.days.sunday[0].end, 1440);
});

test('create: schedule, then its automation, in that order; the automation is on', async () => {
  const hass = house();
  const w = week('Night light', { monday: [{ start: 1200, end: 1440 }] });
  const id = await createScheduleWithAutomation(hass, w, { entityId: 'switch.night_light', name: 'מנורת לילה' }, FAST);
  assert.equal(id, 'schedule.night_light');
  const [create, post] = writes(hass);
  assert.equal(create.type, 'schedule/create');
  assert.deepEqual(create.monday, [{ from: '20:00:00', to: '24:00:00' }]);
  assert.equal(post.method, 'POST');
  assert.equal(post.path, `config/automation/config/${post.body.id}`);
  assert.ok(isOurs(post.body));
  assert.deepEqual(post.body.triggers[0].entity_id, ['schedule.night_light']);
  await new Promise((r) => setTimeout(r, 20));
  const auto = Object.values(hass.states).find((s) => s.attributes.id === post.body.id);
  assert.equal(auto.state, 'on');
  assert.deepEqual(await automationsFor(hass, id), [auto.entity_id]);
});

test('create rolls back the helper when the automation cannot be written', async () => {
  const hass = house();
  hass.failNext('POST config/automation/config', 'Message malformed: extra keys not allowed');
  await assert.rejects(
    createScheduleWithAutomation(hass, week('Doomed', { monday: [{ start: 60, end: 120 }] }), { entityId: 'switch.night_light', name: 'x' }, FAST),
    /Message malformed/,
  );
  const w = writes(hass);
  assert.deepEqual(w.map((c) => c.type || `${c.method} ${c.path.split('/').slice(0, 3).join('/')}`),
    ['schedule/create', 'POST config/automation/config', 'schedule/delete']);
  assert.equal(w[2].schedule_id, 'doomed');
  assert.ok(!('doomed' in (await listSchedules(hass))));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!hass.states['schedule.doomed']);
});

test('HA rejects an overlapping week, and the error text comes through', async () => {
  const hass = house();
  const w = week('Bad', { monday: [{ start: 60, end: 180 }, { start: 120, end: 200 }] });
  await assert.rejects(createScheduleWithAutomation(hass, w, { entityId: 'switch.night_light' }, FAST), (err) => {
    assert.match(errorText(err), /Overlapping/);
    return true;
  });
});

test('update sends the full body and changes the state', async () => {
  const hass = house();
  const all = await listSchedules(hass);
  const w = all.water_heater_weekdays;
  w.days.sunday = [{ start: 8 * 60, end: 10 * 60 }];
  await updateSchedule(hass, 'water_heater_weekdays', w);
  const call = writes(hass)[0];
  assert.equal(call.schedule_id, 'water_heater_weekdays');
  for (const d of ['name', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']) assert.ok(d in call, d);
  // Sunday 09:00 is now inside the range.
  assert.equal(hass.states['schedule.water_heater_weekdays'].state, 'on');
});

test('delete removes Beit automations and keeps hand-written ones', async () => {
  const hass = house();
  const kept = await deleteSchedule(hass, 'schedule.living_room_ac_shabbat');
  assert.deepEqual(kept, ['מאוורר סלון בשבת']);
  const w = writes(hass);
  assert.deepEqual(w.map((c) => c.type || `${c.method} ${c.path}`), ['DELETE config/automation/config/1767000000001', 'schedule/delete']);
  assert.ok(!hass.states['automation.beit_living_room_ac_shabbat']);
  assert.ok(hass.states['automation.living_room_fan_shabbat']);
  assert.ok(!hass.states['schedule.living_room_ac_shabbat']);
});

test('delete of a schedule driven only by hand-written automations deletes no automation', async () => {
  const hass = house();
  const kept = await deleteSchedule(hass, 'schedule.balcony_light');
  assert.deepEqual(kept, ['תאורת מרפסת בערב']);
  assert.ok(!writes(hass).some((c) => c.method === 'DELETE'));
});

test('delete keeps an automation changed after the card created it', async () => {
  const id = 'automation.beit_living_room_ac_shabbat';
  const edited = { ...fixtures.automation_configs[id], mode: 'single' };
  const hass = new FakeHass({
    ...fixtures,
    automation_configs: { ...fixtures.automation_configs, [id]: edited },
  }, { now: SUNDAY_9AM });
  const kept = await deleteSchedule(hass, 'schedule.living_room_ac_shabbat');
  assert.ok(kept.includes(edited.alias));
  assert.ok(hass.states[id]);
  assert.ok(!writes(hass).some((c) => c.method === 'DELETE'));
});

test('setAutomationEnabled', async () => {
  const hass = house();
  await setAutomationEnabled(hass, 'automation.beit_bedroom_ac_shabbat', true);
  assert.equal(hass.states['automation.beit_bedroom_ac_shabbat'].state, 'on');
  await setAutomationEnabled(hass, 'automation.beit_bedroom_ac_shabbat', false);
  assert.equal(hass.states['automation.beit_bedroom_ac_shabbat'].state, 'off');
});

// ---- the fake behaves like HA ------------------------------------------------------------------------------------------

test('weekStatus: state and next_event', () => {
  const w = WeekSchedule.fromHA(fixtures.schedule_list.find((s) => s.id === 'living_room_ac_shabbat'));
  // Friday 17:00: on until Saturday 09:30 (Friday's 24:00 runs into Saturday's 00:00).
  let s = weekStatus(w, new Date(2026, 0, 9, 17, 0));
  assert.equal(s.on, true);
  assert.deepEqual([s.next.getDay(), s.next.getHours(), s.next.getMinutes()], [6, 9, 30]);
  // Saturday 10:00: off until 13:30.
  s = weekStatus(w, new Date(2026, 0, 10, 10, 0));
  assert.equal(s.on, false);
  assert.deepEqual([s.next.getDay(), s.next.getHours(), s.next.getMinutes()], [6, 13, 30]);
  // Sunday: off until Friday 16:00.
  s = weekStatus(w, SUNDAY_9AM());
  assert.deepEqual([s.on, s.next.getDay(), s.next.getHours()], [false, 5, 16]);
  // A range running across the week boundary: Saturday 22:00 → Sunday 02:00.
  const wrap = new WeekSchedule({ name: 'w', days: { saturday: [{ start: 1320, end: 1440 }], sunday: [{ start: 0, end: 120 }] } });
  s = weekStatus(wrap, new Date(2026, 0, 4, 1, 0));
  assert.deepEqual([s.on, s.next.getDay(), s.next.getHours()], [true, 0, 2]);
  assert.deepEqual(weekStatus(new WeekSchedule({ name: 'e' })), { on: false, next: null });
});

test('slugify approximates HA for Hebrew names', () => {
  assert.equal(slugify('Night light'), 'night_light');
  assert.equal(slugify('מזגן סלון'), 'mzgn_slvn');
});

// ---- renaming ------------------------------------------------------------------------------------------------------

import { parseScheduleAutomation, renameScheduleAutomations, buildScheduleAutomation } from '../dist/schedule-helper-card.js';

test('parseScheduleAutomation reads back exactly what the builder wrote, and nothing edited by hand', () => {
  for (const target of [
    { entityId: 'climate.a', name: 'מזגן', hvacMode: 'heat', temperature: 23, brightnessPct: null, turnOffAtEnd: true },
    { entityId: 'climate.a', name: 'מזגן', hvacMode: 'cool', temperature: null, brightnessPct: null, turnOffAtEnd: false },
    { entityId: 'light.l', name: 'אור', hvacMode: null, temperature: null, brightnessPct: 40, turnOffAtEnd: true },
    { entityId: 'water_heater.w', name: 'דוד', hvacMode: null, temperature: 60, brightnessPct: null, turnOffAtEnd: true },
    { entityId: 'cover.c', name: 'תריס', hvacMode: null, temperature: null, brightnessPct: null, turnOffAtEnd: true },
  ]) {
    const cfg = buildScheduleAutomation({ id: '9', scheduleEntityId: 'schedule.s', scheduleName: 'שם', target });
    assert.deepEqual(parseScheduleAutomation(cfg), { scheduleEntityId: 'schedule.s', scheduleName: 'שם', target }, target.entityId);
  }
  const cfg = buildScheduleAutomation({ id: '9', scheduleEntityId: 'schedule.s', scheduleName: 'שם', target: { entityId: 'switch.x', name: 'x' } });
  assert.equal(parseScheduleAutomation({ ...cfg, mode: 'single' }), null, 'edited by hand');
  assert.equal(parseScheduleAutomation({ ...cfg, description: 'mine' }), null, 'no marker');
  // Fixture automations the card wrote parse; hand-written ones don't.
  assert.ok(parseScheduleAutomation(fixtures.automation_configs['automation.beit_bedroom_ac_shabbat']));
  assert.equal(parseScheduleAutomation(fixtures.automation_configs['automation.living_room_fan_shabbat']), null);
});

test('renaming a schedule renames only the Beit automations still named after it', async () => {
  const hass = house();
  const autos = await automationsFor(hass, 'schedule.living_room_ac_shabbat');
  const renamed = await renameScheduleAutomations(hass, autos, 'מזגן סלון שבת', 'מזגן סלון לשבת');
  assert.deepEqual(renamed, ['automation.beit_living_room_ac_shabbat']);
  const post = hass.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, 'config/automation/config/1767000000001');
  assert.equal(post.body.alias, 'Beit · מזגן סלון לשבת');
  // Everything else is as it was.
  assert.deepEqual({ ...post.body, alias: null }, { ...fixtures.automation_configs['automation.beit_living_room_ac_shabbat'], alias: null });
  // The hand-written one, and a Beit one renamed by the user, stay.
  assert.deepEqual(await renameScheduleAutomations(house(), autos, 'שם אחר', 'חדש'), []);
  assert.deepEqual(await renameScheduleAutomations(house(), autos, 'x', 'x'), []);
});

import { rewriteScheduleAutomation } from '../dist/schedule-helper-card.js';

test('rewriteScheduleAutomation changes device and action under the same id, and only when something changed', async () => {
  const hass = house();
  const cfg = fixtures.automation_configs['automation.beit_bedroom_ac_shabbat'];
  assert.equal(await rewriteScheduleAutomation(hass, cfg, {}), false);
  assert.equal(hass.calls.filter((c) => c.method === 'POST').length, 0);
  const target = { entityId: 'climate.bedroom_ac', name: 'מזגן חדר שינה', hvacMode: 'heat', temperature: 22, brightnessPct: null, turnOffAtEnd: true };
  assert.equal(await rewriteScheduleAutomation(hass, cfg, { scheduleName: 'מזגן חדר שינה שבת', target }), true);
  const post = hass.calls.find((c) => c.method === 'POST');
  assert.equal(post.path, 'config/automation/config/1767000000002');
  assert.deepEqual(post.body.actions[0].choose[0].sequence[0].data, { temperature: 22, hvac_mode: 'heat' });
  await new Promise((r) => setTimeout(r, 20));
  // Same entity, same on/off state.
  assert.equal(hass.states['automation.beit_bedroom_ac_shabbat'].state, 'off');
  await assert.rejects(rewriteScheduleAutomation(hass, fixtures.automation_configs['automation.living_room_fan_shabbat'], { target }), /by hand/);
});

import { readSchedules } from '../dist/schedule-helper-card.js';

test('readSchedules reads UI and YAML weeks through get_schedule, which non-admins may call', async () => {
  const hass = house({ isAdmin: false });
  const weeks = await readSchedules(hass, ['schedule.pool_pump', 'schedule.balcony_light']);
  assert.deepEqual(weeks['schedule.pool_pump'].days.monday, [{ start: 360, end: 480 }]);
  assert.equal(weeks['schedule.balcony_light'].days.sunday[0].end, 1440);
  const call = hass.calls.at(-1);
  assert.deepEqual([call.domain, call.service, call.target], ['schedule', 'get_schedule', { entity_id: ['schedule.pool_pump', 'schedule.balcony_light'] }]);
  assert.deepEqual(await readSchedules(hass, []), {});
});

// ---- found in the pre-release review ---------------------------------------------------------------------------

import { scheduleIdsOf } from '../dist/schedule-helper-card.js';

test('an alias the user changed survives a rewrite of what the schedule does', async () => {
  const hass = house();
  const cfg = { ...fixtures.automation_configs['automation.beit_bedroom_ac_shabbat'], alias: 'Beit · My bedroom AC' };
  const target = { ...parseScheduleAutomation(cfg).target, temperature: 21 };
  await rewriteScheduleAutomation(hass, cfg, { target });
  assert.equal(hass.calls.find((c) => c.method === 'POST').body.alias, 'Beit · My bedroom AC');
});

test('a renamed schedule entity keeps its helper id', async () => {
  const hass = house();
  hass._scheduleIds = { 'schedule.balcony_light': 'balcony_light' };
  assert.deepEqual(await scheduleIdsOf(hass, ['schedule.balcony_light', 'schedule.nope']), { 'schedule.balcony_light': 'balcony_light' });
});

test('per-block data survives a round trip', () => {
  const w = WeekSchedule.fromHA({ name: 'n', monday: [{ from: '07:00:00', to: '08:00:00', data: { mode: 'eco' } }] });
  assert.deepEqual(w.toHA().monday, [{ from: '07:00:00', to: '08:00:00', data: { mode: 'eco' } }]);
  assert.deepEqual(w.clone().toHA().monday[0].data, { mode: 'eco' });
});

// ---- the Schedule Helper dashboard --------------------------------------------------------------------------------------------

import { createDashboard, findDashboard, dashboardConfig, DASHBOARD } from '../dist/schedule-helper-card.js';

test('createDashboard makes one new dashboard with the schedule card, and only once', async () => {
  const hass = house();
  assert.equal(await findDashboard(hass), null);
  const r = await createDashboard(hass);
  assert.equal(r.created, true);
  assert.equal(r.url_path, 'schedule-helper');
  const cfg = await hass.callWS({ type: 'lovelace/config', url_path: 'schedule-helper' });
  assert.deepEqual(cfg.views[0].cards.map((c) => c.type), ['custom:schedule-helper-card']);
  assert.deepEqual(cfg, dashboardConfig());
  const again = await createDashboard(hass);
  assert.equal(again.created, false);
  assert.equal(hass.calls.filter((c) => c.type === 'lovelace/dashboards/create').length, 1);
  // The other dashboard was never touched.
  assert.ok(!hass.calls.some((c) => c.type === 'lovelace/config/save' && c.url_path !== DASHBOARD.url_path));
});

test('a dashboard at the address used before the rename (1.2.x) counts as existing', async () => {
  const hass = new FakeHass({ ...fixtures, dashboards: [{ id: 'beit_schedules', url_path: 'beit-schedules', title: 'Mine', mode: 'storage' }] }, { now: SUNDAY_9AM });
  const r = await createDashboard(hass);
  assert.equal(r.created, false);
  assert.equal(r.title, 'Mine');
  assert.ok(!hass.calls.some((c) => c.type === 'lovelace/config/save' || c.type === 'lovelace/dashboards/create'));
});

test('a dashboard whose content cannot be saved is removed again', async () => {
  const hass = house();
  hass.failNext('lovelace/config/save', 'boom');
  await assert.rejects(createDashboard(hass), /boom/);
  assert.equal(await findDashboard(hass), null);
});
