# Server setup and test guide

This guide runs SMPP Tester on a Linux server with Docker and uses it to load-test an SMPP platform (SMSC, gateway, aggregator) from both ends: as a customer sending traffic in, and as a vendor receiving the routed traffic.

```
SMPP Tester (client) ──submit_sm──▶  YOUR PLATFORM  ──submit_sm──▶  SMPP Tester (vendor)
          ◀────────── DLR ─────────                ◀──── DLR ─────
```

## 1. Choose a server

Use a separate server or VM **in the same data centre** as your platform. Running the tester on the platform's own machine makes them compete for CPU, and the results stop describing the platform.

| Resource | For 10,000 TPS |
| --- | --- |
| CPU | 4 dedicated vCPUs with a high clock speed. Shared / burstable vCPUs make TPS fluctuate. The load engine, the vendor and the web server each use one core. |
| Memory | 4 GB |
| Disk | 20 GB (the app writes very little; logs are capped at 30 MB) |
| OS | Ubuntu 22.04 / 24.04 or any Linux with Docker. Host networking does not work on Docker Desktop for macOS/Windows. |
| Network | 1 Gbit/s; latency to the platform under 1 ms. 10,000 TPS with DLRs is roughly 60 Mbit/s across both legs. |

Client and vendor run on the same machine, so end-to-end latency is measured with a single clock.

## 2. Install

```bash
# Docker, if it isn't installed yet
curl -fsSL https://get.docker.com | sudo sh

sudo mkdir -p /opt/smpp-tester && cd /opt/smpp-tester
sudo curl -fsSLO https://raw.githubusercontent.com/peritotr/smpp-tester/main/docker-compose.yml
sudo curl -fsSL https://raw.githubusercontent.com/peritotr/smpp-tester/main/.env.example -o .env
sudo nano .env
```

In `.env`:

- `UI_PASSWORD` — a strong password, at least 8 characters.
- `HOST=127.0.0.1` — keep it (access is covered in the next section).
- `PORT` — `8080` by default. If another service already uses 8080, pick another port, e.g. `18080`.
- `PUBLIC_IP` — the IP your platform will use to reach this server; the UI shows it as the vendor address.

Start and check:

```bash
sudo docker compose up -d
sudo docker compose ps                 # STATUS should be "Up … (healthy)"
curl http://127.0.0.1:8080/healthz     # → ok
```

To build from source instead of pulling the published image: `git clone https://github.com/peritotr/smpp-tester.git /opt/smpp-tester`, then replace the `image:` line in `docker-compose.yml` with `build: .` and run `sudo docker compose up -d --build`.

Profiles, reports, vendor settings and the encryption key live in `/opt/smpp-tester/data`. After a restart the UI comes back on its own (`restart: unless-stopped`), and a vendor that was running is restarted with its last settings.

## 3. Secure access

The tester can push tens of thousands of messages per second into whatever it points at. Don't expose the UI directly to the internet.

**SSH tunnel (recommended).** On your own computer:

```bash
ssh -L 8080:127.0.0.1:8080 user@SERVER_IP
```

Keep that window open and browse to `http://localhost:8080`. If the page that opens is not the SMPP Tester login (for example a "Whitelabel Error Page"), something on your own computer already uses port 8080: tunnel to another local port, e.g. `ssh -L 18080:127.0.0.1:8080 …` and open `http://localhost:18080`.

**Domain name with HTTPS** (if a team will use it). Put it behind nginx; the WebSocket headers are required, otherwise live data doesn't arrive:

```nginx
server {
    listen 443 ssl;
    server_name smpptest.example.com;
    # ssl_certificate ... (e.g. with certbot)
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 1h;
    }
}
```

**Firewall.** Open the vendor port only to your platform:

```bash
sudo ufw allow OpenSSH
sudo ufw allow from PLATFORM_IP to any port 2776 proto tcp
sudo ufw enable
```

Repeat the second line for each IP your platform connects from; add `sudo ufw allow 443/tcp` if you use nginx. With host networking these rules apply to the container as well.

The login page locks an IP out for 10 minutes after 10 wrong passwords. Saved profile passwords are encrypted with AES-256-GCM.

## 4. Connect your platform

Start the vendor first, then configure the platform, then connect the client. Use a dedicated test customer and a number range used only for testing, so real traffic is never affected.

1. **Start the vendor** (bottom left, *Vendor*): listen on *Network (0.0.0.0)*, port `2776`, a vendor system_id and password, DLR delay close to a real operator (e.g. `1500` ms). Press **Start**; the address to give your platform appears below.
2. **On your platform, add a vendor/supplier connection:**

   | Field | Value |
   | --- | --- |
   | Host | The test server's IP (private IP if on the same network) |
   | Port | 2776 |
   | system_id / password | As set in step 1 |
   | Bind type | **Transceiver** — DLRs come back on the same connection; with a transmitter bind no DLRs arrive |
   | Route | A test range (e.g. `4477009…`) to this vendor only |
   | Vendor TPS limit | Above your test target |

3. **Add a test customer** with enough credit, a TPS limit above your target, and the sender ID you will use allowed.
4. **Connect the client** (top left, *Server*): your platform's address and the test customer's credentials. **Save** it as a profile. Press **Connect** on the *Single test* tab; the state should read *bound*. When the vendor section shows *Bound 1* or more, your platform is connected to the vendor.

**Bind limits.** If your platform limits binds per customer (e.g. 10), the load test sessions plus the single-test connection must stay under it. Disconnect the single test before a load test. If some sessions can't bind, the test continues with the ones that did and the report says so.

## 5. Test plan

Run the steps in order and don't move on until a step passes. Keep *Request DLR* and *Measure end-to-end* on and the recipient within the test range.

1. **Smoke test** (*Single test*): a short message, a Unicode message (UCS-2) and a 3-part long message. All three should get `ESME_ROK`, and their DLRs should appear in the inbox matched to the right message_id.
2. **End-to-end check** (*Load test*, constant): 10 TPS for 60 s, 1 session. Nothing missing, no duplicates.
3. **Step test**: start 500, increment 500, target 10,000, step 120 s, 8 sessions, window 500 (about 40 minutes). The report shows the step at which latency rises and where the platform saturates.
4. **Target load**: constant 10,000 TPS for 10 minutes. Accepted ≈ target, no errors, nothing missing, end-to-end p95 under your goal.
5. **Endurance**: 5,000 TPS for 1–2 hours. Watch for latency that keeps climbing (a growing queue or a leak) and for the platform's memory use.
6. **Failure scenarios**: run 2,000 TPS and change one vendor setting at a time (stop the vendor, change it, start it again):
   - *TPS limit* `1000` — does the platform handle the vendor's throttling and queue correctly, with nothing lost at the end?
   - *Response delay* `500` ms — does the platform cope with a slow vendor?
   - *DLR failure %* `20` — do UNDELIV DLRs reach the customer correctly?
   - *Processing capacity* below your load — a vendor whose queue grows.
   - Stop the vendor for 30 s mid-test — does the platform reconnect, deliver what was pending, and avoid duplicates?

**Sessions and window.** Per session, the window should be at least `2 × target TPS × response time (s) ÷ sessions`. For 10,000 TPS at 50 ms with 8 sessions that is ~125; the default 500 is plenty. If your customers use a small window (10–100), also test with theirs to see realistic behaviour.

## 6. Reading the results

The three numbers that matter most are accepted TPS (what the platform takes in), end-to-end p95 (how fast it forwards to the vendor) and missing messages (loss). The rest tells you where a problem is.

| You see | Meaning | Next step |
| --- | --- | --- |
| Accepted TPS below target, no throttling, *In flight* ≈ sessions × window | The platform answers slowly and the window is full | Look at response p99; the intake stage is the bottleneck. A bigger window only makes the queue longer. |
| Throttle > 0 | The customer TPS limit was hit | Check the limit; raise it unless you are testing it on purpose |
| Response p99 jumps at a step | `submit_sm_resp` slows down (database, queue, lock) | That step is the limit of the intake stage |
| End-to-end p95 rises while response p99 stays low | The platform accepts quickly but forwards to the vendor late | Routing / outbound queue is the bottleneck |
| Missing > 0 after the test | Lost, or still queued inside the platform | Raise *DLR wait* and watch the number: falling = queue, flat = loss |
| Duplicates > 0 | The platform sent the same message to the vendor twice | Retry logic, usually after a timeout |
| Unmatched DLRs > 0 | The id in the DLR differs from the one in `submit_sm_resp` | Make sure the platform uses the message_id it gave the customer |
| Timeouts > 0 | No `submit_sm_resp` at all | Check platform logs; try a higher *Response limit* |
| DLR latency far above the vendor's DLR delay | DLRs wait inside the platform | DLR matching (often a missing index on message_id), DLR queue workers |

DLR latency = the vendor's DLR delay + the time the platform takes to pass the DLR back. With the vendor at 1,500 ms and a p95 of 1,650 ms, the platform adds about 150 ms.

## 7. Troubleshooting

First look at the container log: `sudo docker compose logs --tail 100`.

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Container keeps restarting | `UI_PASSWORD` empty or shorter than 8 characters | Fix `.env`, then `sudo docker compose up -d` |
| `EACCES … /data` in the log (older versions) | The data folder belongs to root | `sudo chown -R 1000:1000 /opt/smpp-tester/data && sudo docker compose restart` |
| `curl: (7) Failed to connect` | The container is not running, or `PORT` differs | `sudo docker compose ps`, check the log and `.env` |
| Browser shows another application's page | Something else uses that port on your computer | Tunnel to another local port (section 3) |
| "Lost connection to the server" banner | Missing WebSocket headers in the reverse proxy | Add the `Upgrade` / `Connection` lines |
| "Port … is already in use" when starting the vendor | Another service uses that port | Choose another port and update the firewall |
| The platform can't reach the vendor | Firewall, wrong IP, vendor stopped | `sudo ufw status`; from the platform server: `nc -vz TEST_SERVER_IP 2776` |
| Vendor shows *Bound 0* but the platform says connected | The platform's bind was rejected | Same system_id / password on both sides? |
| Client gets `ESME_RBINDFAIL` | Wrong test customer credentials | Check the customer on the platform |
| Test stuck at "Binding…" (older versions) or sessions missing | The platform's bind limit is reached | Fewer sessions, disconnect the single test, wait for stale binds to time out |
| High accepted TPS but nothing reaches the vendor | No route, routed elsewhere, or the text is modified | Check routing; if a content filter rewrites the text, the `#T…` end-to-end marker is lost |
| No DLRs | The platform binds to the vendor as a transmitter | Use a transceiver bind |

## 8. Updating

```bash
cd /opt/smpp-tester
sudo docker compose pull && sudo docker compose up -d
```

`data/` and `.env` are kept. To change the password, edit `UI_PASSWORD` in `.env` and run `sudo docker compose up -d`; existing sessions are signed out. Back up `data/`; if `secret.key` is lost, saved profile passwords can no longer be decrypted and must be entered again.
