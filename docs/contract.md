# Schedule Helper Card Lite data contract

The card edits Home Assistant's native `schedule` helpers through the WebSocket `schedule/list`, `schedule/create`, `schedule/update`, and `schedule/delete` commands. The helper's seven day arrays contain time blocks with `from` and `to` in `HH:MM:SS` format. A block may carry a `data` object, which the card preserves. `24:00:00` means midnight at the end of the day.

Each new schedule has a normal Home Assistant automation written through `POST /api/config/automation/config/<id>`. It responds to the schedule entity changing to `on` and, if configured, `off`. The automation description includes the original Beit marker for compatibility with schedules created before this fork. The card only rewrites or deletes a related automation if its configuration still matches the card's generated shape. Hand-edited automations are left for the user to manage in Home Assistant.

The card may create a storage dashboard at `schedule-helper`, with one `custom:schedule-helper-card` in its view. It does not modify existing dashboards.
