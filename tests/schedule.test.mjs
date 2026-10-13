// A port of the Beit app's test/schedule_test.dart (the first four tests, one for one), plus the helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WeekSchedule, parseBlock, formatBlock, blockLabel, DAYS, BEIT_MARKER, buildScheduleAutomation, onActions, offActions,
  isOurs,
} from '../dist/schedule-helper-card.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url)));

// ---- schedule_test.dart ----------------------------------------------------------------------------------------

test('round-trips HA schedule JSON, including 24:00 and 23:59:59 ends', () => {
  const w = WeekSchedule.fromHA({
    name: 'AC Boys',
    friday: [{ from: '22:00:00', to: '24:00:00' }],
    saturday: [
      { from: '13:30:00', to: '17:30:00' },
      { from: '00:00:00', to: '09:30:00' },
    ],
    sunday: [{ from: '16:00:00', to: '23:59:59' }],
  });
  const j = w.toHA();
  assert.deepEqual(j.friday, [{ from: '22:00:00', to: '24:00:00' }]);
  // Sorted on the way out.
  assert.deepEqual(j.saturday[0], { from: '00:00:00', to: '09:30:00' });
  assert.deepEqual(j.sunday, [{ from: '16:00:00', to: '24:00:00' }]);
  assert.deepEqual(j.monday, []);
  assert.equal(w.validate(), null);
});

test('rejects overlaps and reversed blocks', () => {
  const w = new WeekSchedule({ name: 'x', days: { monday: [{ start: 600, end: 720 }, { start: 700, end: 800 }] } });
  assert.match(w.validate('he'), /חופפים/);
  const r = new WeekSchedule({ name: 'x', days: { monday: [{ start: 700, end: 600 }] } });
  assert.match(r.validate('he'), /לפני/);
  assert.notEqual(new WeekSchedule({ name: ' ' }).validate(), null);
});

test('builds an on/off automation that ignores restarts', () => {
  const a = buildScheduleAutomation({
    id: '1',
    scheduleEntityId: 'schedule.salon',
    scheduleName: 'סלון שבת',
    target: { entityId: 'climate.salon', name: 'מזגן סלון', hvacMode: 'cool', temperature: 24 },
  });
  assert.equal(a.triggers.length, 2);
  assert.ok(a.triggers[0].not_from.includes('unavailable'));
  assert.ok(a.description.includes(BEIT_MARKER));
  const choose = a.actions[0].choose;
  const on = choose[0].sequence[0];
  assert.equal(on.action, 'climate.set_temperature');
  assert.deepEqual(on.data, { temperature: 24.0, hvac_mode: 'cool' });
  assert.equal(choose.at(-1).sequence[0].action, 'climate.turn_off');
});

test('no off trigger when the device should stay on', () => {
  const a = buildScheduleAutomation({
    id: '2',
    scheduleEntityId: 'schedule.x',
    scheduleName: 'x',
    target: { entityId: 'light.x', name: 'x', turnOffAtEnd: false },
  });
  assert.equal(a.triggers.length, 1);
  assert.equal(a.actions[0].choose.length, 1);
});

// ---- the full JSON, as the Dart builder writes it ----------------------------------------------------------------

test('the automation JSON matches the contract exactly', () => {
  const a = buildScheduleAutomation({
    id: '1790000000000',
    scheduleEntityId: 'schedule.living_room_ac_shabbat',
    scheduleName: 'מזגן סלון שבת',
    target: { entityId: 'climate.living_room_ac', name: 'מזגן סלון', hvacMode: 'heat' },
  });
  assert.deepEqual(a, {
    id: '1790000000000',
    alias: 'Beit · מזגן סלון שבת',
    description: 'נוצר באפליקציית Beit — מזגן סלון לפי schedule.living_room_ac_shabbat',
    triggers: [
      { trigger: 'state', entity_id: ['schedule.living_room_ac_shabbat'], to: ['on'], not_from: ['unavailable', 'unknown'], id: 'schedule_on' },
      { trigger: 'state', entity_id: ['schedule.living_room_ac_shabbat'], to: ['off'], not_from: ['unavailable', 'unknown'], id: 'schedule_off' },
    ],
    conditions: [],
    actions: [{ choose: [
      { conditions: [{ condition: 'trigger', id: 'schedule_on' }], sequence: [{ action: 'climate.set_hvac_mode', target: { entity_id: 'climate.living_room_ac' }, data: { hvac_mode: 'heat' } }] },
      { conditions: [{ condition: 'trigger', id: 'schedule_off' }], sequence: [{ action: 'climate.turn_off', target: { entity_id: 'climate.living_room_ac' } }] },
    ] }],
    mode: 'queued',
  });
});

test('on and off actions per domain', () => {
  const t = (entityId, extra = {}) => ({ entityId, ...extra });
  assert.deepEqual(onActions(t('climate.a')), [{ action: 'climate.set_hvac_mode', target: { entity_id: 'climate.a' }, data: { hvac_mode: 'cool' } }]);
  assert.deepEqual(onActions(t('climate.a', { temperature: 22 })), [{ action: 'climate.set_temperature', target: { entity_id: 'climate.a' }, data: { temperature: 22 } }]);
  assert.deepEqual(onActions(t('water_heater.w', { temperature: 55 })).map((a) => a.action), ['water_heater.turn_on', 'water_heater.set_temperature']);
  assert.deepEqual(onActions(t('water_heater.w')).length, 1);
  assert.deepEqual(onActions(t('light.l', { brightnessPct: 40 })), [{ action: 'light.turn_on', target: { entity_id: 'light.l' }, data: { brightness_pct: 40 } }]);
  assert.deepEqual(onActions(t('light.l')), [{ action: 'light.turn_on', target: { entity_id: 'light.l' } }]);
  assert.equal(onActions(t('cover.c'))[0].action, 'cover.open_cover');
  assert.equal(onActions(t('valve.v'))[0].action, 'valve.open_valve');
  assert.equal(onActions(t('switch.s'))[0].action, 'switch.turn_on');
  assert.equal(offActions(t('cover.c'))[0].action, 'cover.close_cover');
  assert.equal(offActions(t('valve.v'))[0].action, 'valve.close_valve');
  assert.equal(offActions(t('media_player.m'))[0].action, 'media_player.media_pause');
  assert.equal(offActions(t('water_heater.w'))[0].action, 'water_heater.turn_off');
  assert.deepEqual(offActions(t('switch.s', { turnOffAtEnd: false })), []);
});

// ---- the week model ------------------------------------------------------------------------------------------------

test('parses and formats blocks at minute precision', () => {
  assert.equal(parseBlock('00:00:00'), 0);
  assert.equal(parseBlock('09:30:00'), 570);
  assert.equal(parseBlock('24:00:00'), 1440);
  assert.equal(parseBlock('23:59:59'), 1440);
  assert.equal(parseBlock('23:59:00'), 1439);
  assert.equal(parseBlock('07:15:30'), 435);
  assert.equal(formatBlock(1440), '24:00:00');
  assert.equal(formatBlock(435), '07:15:00');
  assert.equal(blockLabel({ start: 1320, end: 1440 }), '22:00–24:00');
});

test('toHA writes the days Sunday first', () => {
  assert.deepEqual(Object.keys(new WeekSchedule({ name: 'n' }).toHA()), ['name', ...DAYS]);
});

test('English validation messages', () => {
  const r = new WeekSchedule({ name: 'x', days: { friday: [{ start: 700, end: 600 }] } });
  assert.match(r.validate('en'), /Friday/);
});

test('every synthetic fixture round-trips to what HA would store', () => {
  for (const item of fixture('schedule_list')) {
    const w = WeekSchedule.fromHA(item);
    assert.equal(w.validate(), null, item.id);
    const out = w.toHA();
    const again = WeekSchedule.fromHA(out).toHA();
    assert.deepEqual(again, out, item.id);
    for (const d of DAYS) {
      assert.equal(out[d].length, item[d].length);
      for (const b of out[d]) assert.notEqual(b.to, '23:59:59');
    }
  }
});

// ---- helpers -------------------------------------------------------------------------------------------------------

test('isOurs looks for the marker in the description', () => {
  assert.equal(isOurs({ description: `${BEIT_MARKER} — x` }), true);
  assert.equal(isOurs({ description: 'hand-written' }), false);
  assert.equal(isOurs(null), false);
});
