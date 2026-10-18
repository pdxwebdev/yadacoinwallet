# Wallet Test Fixtures

Paste these into the wallet UI at `http://localhost:5173/wallet/` (dev) or your deployed URL.

## Credentials (import via Receive tab → "or import directly")

| File                               | Type                           | Tests                                                                  |
| ---------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `credential-python-obv3.json`      | OBv3 / OpenBadgeCredential     | Rich display: achievement image, criteria, display colors, issuer logo |
| `credential-military-mos.json`     | OBv3 / OpenBadgeCredential     | Military credential with green display branding                        |
| `credential-sparse-workforce.json` | Plain VC / WorkforceCredential | Graceful degradation — no display metadata, no achievement block       |

## Presentation Requests (paste via Present tab)

| File                               | Requests                                                                 | Notes                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `presentation-request-python.json` | `achievement.name` + `criteria.narrative` from any `OpenBadgeCredential` | Posts VP to `https://httpbin.org/post` — check Network tab for response |

## Suggested test sequence for RFP pilot demo

1. Import all three credentials via Receive → "or import directly"
2. Navigate to Credentials tab — verify card colors, logos, OBv3 rendering, and sparse fallback
3. Open the Python credential detail — verify criteria block and badge image
4. Navigate to Present tab
5. Paste `presentation-request-python.json` → Load Request
6. Check the selective disclosure checkboxes, click Send
7. Open browser Network tab, find the POST to `httpbin.org/post`, verify `vp_token` in request body
