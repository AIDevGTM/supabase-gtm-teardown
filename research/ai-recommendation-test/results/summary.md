# Results (primary)

Responses scored: 1020

**Overall (excluding controls):** Supabase first pick 46.9% (43.6 to 50.2), mentioned 93.8% (92.0 to 95.2)

| Model | n | First pick | Mentioned | Firebase first pick |
| --- | --- | --- | --- | --- |
| Claude Opus 5.5 | 300 | 47.7% (42.1 to 53.3) | 95.3% | 3.7% |
| Claude Haiku 5.5 | 300 | 46.7% (41.1 to 52.3) | 92.3% | 7.0% |
| Claude Sonnet 5.5 | 300 | 46.3% (40.8 to 52.0) | 93.7% | 3.7% |

| Prompt group | n | First pick | Mentioned |
| --- | --- | --- | --- |
| generic_backend | 180 | 86.1% (80.3 to 90.4) | 100.0% |
| firebase_alt | 150 | 82.0% (75.1 to 87.3) | 100.0% |
| stack_specific | 180 | 42.8% (35.8 to 50.1) | 100.0% |
| ai_app | 150 | 19.3% (13.8 to 26.4) | 74.0% |
| realtime | 120 | 18.3% (12.4 to 26.2) | 85.8% |
| postgres_hosting | 120 | 13.3% (8.4 to 20.6) | 100.0% |
| control | 120 | 0.0% (0 to 3.1) | 0.0% |

## Hypotheses

```json
{
 "H1_generic_first_pick_over_50_all_vendors": {
  "by_segment": {
   "Claude Opus 5.5": 86.7,
   "Claude Sonnet 5.5": 86.7,
   "Claude Haiku 5.5": 85.0
  },
  "holds": true
 },
 "H2_firebase_alt_over_80": {
  "value": [
   82.0,
   75.1,
   87.3
  ],
  "holds": true
 },
 "H3_ai_below_generic": {
  "ai": [
   19.3,
   13.8,
   26.4
  ],
  "generic": [
   86.1,
   80.3,
   90.4
  ]
 },
 "H4_controls_under_10": {
  "value": [
   0.0,
   0,
   3.1
  ],
  "holds": true
 },
 "H6_vendor_spread_under_15": {
  "tested": false,
  "by_vendor": {
   "anthropic": 46.9
  },
  "spread": 0.0
 }
}
```