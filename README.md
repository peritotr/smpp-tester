# SMPP Tester

**SMPP client, load tester and mock vendor (SMSC) in one tool — with performance reports that tell you where your platform starts to slow down.**

Use it as a desktop app (macOS, Windows, Linux) for quick checks, or run it on a server with Docker and drive it from your browser for serious load tests.

[Türkçe](README.tr.md) · [Server setup guide](docs/server-setup.md) · [Changelog](CHANGELOG.md)

![Load test view](docs/screenshots/load-test.png)

## Why

When you build or operate an SMSC, an SMS gateway or an aggregator hub, you need to answer questions like:

- How many TPS does the platform really sustain, and at what load does latency start to climb?
- Does every accepted message reach the downstream vendor — exactly once?
- How long do DLRs take to come back, and does that change under load?
- What happens when a vendor throttles, slows down or disconnects?

SMPP Tester can act as **both ends** of your platform at the same time: a customer (ESME) sending traffic in, and a vendor (SMSC) receiving the routed traffic and returning DLRs. Because it sees both sides, it can measure end-to-end latency, loss and duplicates through your platform.

```
SMPP Tester (client) ──submit_sm──▶  YOUR PLATFORM  ──submit_sm──▶  SMPP Tester (vendor)
          ◀────────── DLR ─────────                ◀──── DLR ─────
```

## Features

**Single test**
- Full connection settings: host, port, TLS, system_id, password, system_type, bind type (TRX/TX/RX), interface version, TON/NPI, address range, enquire_link interval; saved profiles with encrypted passwords
- `submit_sm` with GSM-7, Latin-1 or UCS-2 (auto-detected), concatenated messages via UDH or `message_payload`, live character/part counter
- Sent messages table with `submit_sm_resp` status, message_id, response time, DLR status and DLR latency; DLR and MO inbox; full PDU log with export

**Load test**
- Parallel binds (sessions), per-session window, target TPS with ramp-up, by duration or message count
- **Step test**: climbs from a start TPS to a target in steps to find the knee point
- Automatic slow-down and retry on `ESME_RTHROTTLED` / `ESME_RMSGQFUL`
- Random recipients (`4477009XXXXX`), live TPS and latency charts (p50/p95/p99), error code and DLR status breakdown
- Sustains 10,000 TPS with DLRs on a 2-vCPU machine (client and mock vendor on the same box)

**Built-in vendor (mock SMSC)**
- Your platform binds to it as a supplier; it accepts messages and returns DLRs
- Configurable DLR delay and failure rate, TPS limit (returns throttling errors), response delay, processing capacity (simulates a slow operator with a growing queue), MO messages
- **End-to-end tracking**: messages carry a marker; the vendor reports how many arrived, how many were lost or duplicated, and the end-to-end latency through your platform

**Performance reports**
- Saved automatically after every load test; printable to PDF, exportable to CSV/JSON
- Finds the **latency onset** (when and at what TPS p95 left its baseline), the **saturation point** and its likely cause (throttling, backpressure, session loss, errors), peak capacity, latency drift under steady load
- Acceptance criteria (p95/p99, end-to-end p95, error rate, loss, minimum TPS) → **PASSED / FAILED**
- Step table, latency-vs-load curve, annotated timelines, event log

![Report](docs/screenshots/report.png)

**Interface in English and Turkish** (switch in the top-left corner).

## Getting started

### Desktop app

Download the latest build for your OS from [Releases](https://github.com/peritotr/smpp-tester/releases):

| OS | File |
| --- | --- |
| macOS (Apple Silicon / Intel) | `SMPP-Tester-x.y.z-mac-arm64.dmg` / `-mac-x64.dmg` |
| Windows | `SMPP-Tester-x.y.z-win-x64-setup.exe` (installer) or `-win-x64-portable.exe` |
| Linux | `SMPP-Tester-x.y.z-linux-x86_64.AppImage` or `-linux-x64.tar.gz` |

The builds are not code-signed. On macOS, the first time you open the app, go to **System Settings → Privacy & Security → Open Anyway** (or run `xattr -dr com.apple.quarantine "/Applications/SMPP Tester.app"`). On Windows, click **More info → Run anyway** in SmartScreen.

To run from source instead:

```bash
git clone https://github.com/peritotr/smpp-tester.git
cd smpp-tester
npm install
npm start
```

### Server (Docker)

For load tests, run it on a Linux server in the same data centre as your platform — but not on the same machine.

```bash
mkdir smpp-tester && cd smpp-tester
curl -fsSLO https://raw.githubusercontent.com/peritotr/smpp-tester/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/peritotr/smpp-tester/main/.env.example -o .env
nano .env                    # set UI_PASSWORD
docker compose up -d
```

Then open the UI through an SSH tunnel from your computer:

```bash
ssh -L 8080:127.0.0.1:8080 user@your-server
# browse to http://localhost:8080
```

The full walkthrough — server sizing, firewall, reverse proxy with HTTPS, platform configuration and a test plan — is in **[docs/server-setup.md](docs/server-setup.md)**.

Without Docker: `npm install --omit=dev && UI_PASSWORD=... node server.js`.

| Variable | Default | |
| --- | --- | --- |
| `UI_PASSWORD` | — | Required, at least 8 characters |
| `PORT` | `8080` | Web UI port |
| `HOST` | `0.0.0.0` (`127.0.0.1` in `.env.example`) | Address the web UI listens on |
| `DATA_DIR` | `./data` (`/data` in Docker) | Profiles, reports, vendor settings, secret key |
| `PUBLIC_IP` | — | IP shown as the vendor address in the UI |

## Testing your platform: a quick recipe

1. **Start the vendor** (bottom left): listen on *Network (0.0.0.0)*, port e.g. `2776`, a system_id and password.
2. **On your platform**, add a vendor/supplier connection to that IP:port as a **transceiver**, and route a test number range (e.g. `4477009…`) only to it.
3. **Create a test customer** on your platform with a TPS limit above your target.
4. **Connect the client** (top left) to your platform with that customer and send a single message to check the path end to end.
5. **Load test → Step**: start 500, increment 500, target 10,000, step 60 s, *Measure end-to-end* on. When it finishes, open the report.

### Choosing sessions and window

A session can carry roughly `window ÷ response time` messages per second. Size the window per session to at least
`2 × target TPS × response time (s) ÷ sessions` — for 10,000 TPS at 50 ms with 8 sessions that is about 125. If the *In flight* counter sits at `sessions × window`, the window is full: that means the platform is responding slowly, and a bigger window only makes the queue longer.

## How the analysis works

- **Baseline** — median p95 of the first, lightly loaded seconds (the first step in a step test).
- **Latency onset** — p95 above `max(2 × baseline, baseline + 20 ms)` (or the acceptance limit, if lower) for 3 consecutive seconds.
- **Saturation** — accepted TPS below 90% of a flat target for 3 consecutive seconds. The cause is inferred from that window: throttle responses → throttling; fewer bound sessions → session loss; window full > 30% of the time → backpressure; error responses → errors; otherwise the test machine could not keep up.
- **Step status** — a step is *saturated* when its median accepted TPS is below 95% of the step target, and *latency up* when its p95 is above the onset threshold.
- **Peak capacity** — best 10-second average of accepted TPS.

## Project layout

| Path | |
| --- | --- |
| `smpp-core.js` | Interactive SMPP client and encoding helpers |
| `load-engine.js`, `load-worker.js` | Load engine (own process): sessions, windowing, token-bucket rate control, histograms |
| `mock-smsc.js`, `mock-worker.js` | Mock vendor on raw sockets (own process) |
| `reports.js`, `ui/analysis.js` | Report archive and performance analysis |
| `main.js`, `preload.js` | Desktop app (Electron) |
| `server.js`, `ui/web-api.js` | Web server edition (HTTP + WebSocket, password login) |
| `ui/` | User interface (plain HTML/CSS/JS, no framework), `ui/i18n.js` for translations |
| `test/` | Test suite (`npm test`) |
| `tools/` | `bench.js` (CLI benchmark), `report-demo.js`, `i18n-keys.js` |

## Development

```bash
npm install
npm start          # desktop app
npm run server     # web edition (set UI_PASSWORD first)
npm test           # client, load engine, analysis and translation tests
npm run bench      # 10,000 TPS for 30 s against the built-in vendor
npm run dist       # build installers for the current OS into dist/
```

Pushing a tag like `v1.4.0` builds the desktop apps for all three platforms, creates a GitHub Release, and publishes the Docker image to `ghcr.io/peritotr/smpp-tester`.

**Adding a language:** add a dictionary next to `TR` in `ui/i18n.js`, register it in `DICTS` and `LOCALES`, and add an `<option>` to the language selectors. `npm run i18n` lists strings that are still missing.

Issues and pull requests are welcome.

## Security

The web edition can push tens of thousands of messages per second into the platform it points at. Keep the UI behind an SSH tunnel or an HTTPS reverse proxy, use a strong `UI_PASSWORD`, and open the vendor port only to your platform's IP. Saved passwords are encrypted at rest (OS keychain on desktop, AES-256-GCM on the server).

Only test platforms you own or are authorised to test.

## License

[MIT](LICENSE) © Levent Karamanlı

Built on [node-smpp](https://github.com/farhadi/node-smpp).
