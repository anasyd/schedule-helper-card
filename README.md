# Schedule Helper Card Lite

A Home Assistant dashboard card for creating and editing weekly schedules for lights, switches, heating, water heaters, covers, and other supported entities. This fork keeps the general schedule card and removes the Shabbat and Jewish holiday modes.

## What it creates

The card uses Home Assistant's native `schedule` helper and a normal automation that acts on the selected device. The schedule and automation remain in Home Assistant if the card is removed. An administrator can create and edit schedules; other users can view them.

A schedule has one or more daily time ranges. At the start of a range, the automation runs the selected on action. At the end, it runs the off action if that option is enabled. For climate entities, the card can set an HVAC mode and target temperature. For lights, it can set brightness.

To use one time range on several days, press **+ Range** on any day, enter the time, then select **Weekdays** (Monday–Friday), **Every day**, or individual days before pressing **OK**. Add separate ranges for Saturday and Sunday. The new range is added to each selected day; existing ranges remain in place. If it overlaps an existing range on any selected day, the editor shows that day and changes none of them.

The generated automation responds to schedule state transitions. It does not currently reapply a device state after Home Assistant restarts during an active range. Test that behavior before relying on it for heating or other important equipment.

## Install from this fork

1. In HACS, open **Custom repositories**.
2. Add `https://github.com/anasyd/schedule-helper-card` as a **Dashboard** repository.
3. Find **Schedule Helper Card** in HACS and install it.
4. Refresh the Home Assistant browser or Companion app.
5. Add a **Custom: Schedule Helper Card** to a dashboard, or use its visual editor to create a dedicated Schedule Helper dashboard.

Manual resource path, if needed: `/hacsfiles/schedule-helper-card/schedule-helper-card.js`, resource type **JavaScript module**.

## Configuration

Minimal card:

```yaml
type: custom:schedule-helper-card
```

Optional settings:

```yaml
type: custom:schedule-helper-card
title: Weekly schedules
show_add: true
device_domains:
  - climate
  - light
  - switch
height: 500px
```

The visual editor can also choose which schedule entities appear on the card. Existing dashboards using `custom:beit-schedule-card` continue to work.

## Security and scope

The code installed by HACS is `dist/schedule-helper-card.js`. It has no runtime package dependencies, remote script loading, external network requests, or `eval`. It talks to the Home Assistant APIs available to the logged-in user. Like any dashboard card, it runs in the user's browser with that user's Home Assistant permissions, so only use the editing features with a trusted administrator account.

This fork's deletion path only removes a related automation if its full configuration still matches the card's generated shape. Hand-edited and unrelated automations are left alone.

## Development

```sh
node --test 'tests/*.test.mjs'
node dev/ui-test.mjs
python3 dev/serve.py
```

The preview server serves synthetic fixtures on localhost and does not connect to a real Home Assistant instance.

Based on [yybd/schedule-helper-card](https://github.com/yybd/schedule-helper-card). MIT license; see [LICENSE](LICENSE).
