# CloudPing — modern cloud latency test

A complete, modern redesign of [CloudPingTest](https://github.com/VarunAgw/CloudPingTest) by Varun Agrawal —
rebuilt as a fully static, zero-dependency single-page app that runs anywhere (including GitHub Pages).

**Live demo:** https://letmefind.github.io/CloudPingTest/

## What it does

Measures real round-trip latency from your browser to **300+ regions across 15 cloud providers**
(AWS, Azure, GCP, DigitalOcean, Oracle Cloud, Vultr, Hetzner, Linode, IBM Cloud, OVHcloud, Scaleway,
Gcore, Contabo, CoreWeave, servers.com) — no installs, no sign-ups.

## Features

- 🎨 Claude-inspired design — warm light & dark themes, serif display type, smooth micro-animations
- ⚡ Live results — animated latency bars, per-region sparklines, color-coded heat scale
- 🏆 Podium of the 3 fastest regions, updated every round
- 🔀 Test any combination of providers at once
- 📊 Median / mean / min / max / jitter per region, sortable columns, instant filtering
- 📥 One-click CSV export
- 💾 Your provider selection, theme and sort order are remembered locally

## How it works

The classic image-beacon trick: the app loads a tiny resource from each region's public endpoint
and measures the round-trip time with `performance.now()`. A warm-up round (DNS + TLS) is discarded,
then rounds repeat until you press Stop.

## Run locally

It's pure HTML/CSS/JS — any static server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Credits

- Original project, region catalog and endpoints: [VarunAgw/CloudPingTest](https://github.com/VarunAgw/CloudPingTest)
  — consider [donating](https://varunagw.com/donate) to support it.
- Redesign: static SPA in `index.html` + `assets/` (the original PHP files are kept for reference).
