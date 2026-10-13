# Schedule Helper Card Lite

This fork ships one Home Assistant dashboard card in `dist/schedule-helper-card.js`. Keep the card small and reviewable. It uses Home Assistant's native schedule helpers and automations.

Never commit real Home Assistant credentials, URLs, device identifiers, or household data. The fixtures in `tests/fixtures` are synthetic. The offline preview in `dev/card-preview.html` must remain offline.

Run `node --test 'tests/*.test.mjs'` and `node dev/ui-test.mjs` after changing the card. Make one logical change per commit.
