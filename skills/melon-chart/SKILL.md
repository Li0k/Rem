---
name: melon-chart
description: Fetch and parse public Melon chart pages into structured JSON or CSV. Use when Codex needs to collect Melon TOP100, daily, weekly, monthly, or rise chart snapshots, compare chart movement over time, or build local data for K-pop taste analysis and recommendation workflows.
metadata:
  short-description: Fetch Melon chart snapshots for analysis
---

# Melon Chart

Use the bundled script to turn public Melon chart pages into structured snapshot files.

## Workflow

1. Run `scripts/fetch_melon_chart.py` with a supported chart type.
2. Save the response as JSON for downstream analysis, or CSV for spreadsheet work.
3. Build your own local snapshot history instead of relying on the live site for trend analysis.

## Supported Charts

- `top100`
- `day`
- `week`
- `month`
- `rise`

## Common Commands

Fetch the current hourly TOP100:

```bash
python3 skills/melon-chart/scripts/fetch_melon_chart.py --chart top100 --format json --output /tmp/melon-top100.json
```

Fetch a specific hourly snapshot:

```bash
python3 skills/melon-chart/scripts/fetch_melon_chart.py --chart top100 --day-time 2026030820 --limit 20
```

Fetch a genre-specific daily chart:

```bash
python3 skills/melon-chart/scripts/fetch_melon_chart.py --chart day --class-cd GN0200 --format csv --output /tmp/melon-day-dance.csv
```

## Notes

- Prefer low-frequency snapshotting and local reuse for analysis.
- `--day-time` is most useful on hourly pages such as `top100` and `rise`.
- `--class-cd` lets you target Melon genre buckets when the page supports them.
