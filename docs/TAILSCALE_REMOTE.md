# Tailscale remote HUD

Control Ultron from your phone over Tailscale. Ultron never binds to `0.0.0.0`.

## User steps

1. Install Tailscale on the PC and phone, sign in to the same tailnet.
2. On the PC, copy `config/computer-allowlist.example.json` to `.ultron/config/computer-allowlist.json` and edit paths.
3. Start Ultron on the Tailscale address only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-ultron.ps1 -Tailscale
```

4. Mint a device token on the PC (launcher event token is already in the Ultron process environment while it is running). From another elevated shell on the same PC, with the server up:

```powershell
$base = (Get-Content .ultron/runtime/processes.json | ConvertFrom-Json).base_url
# Use the same ULTRON_LOCAL_EVENT_TOKEN the launcher printed into the server environment,
# or mint via a small local helper while Ultron is running under the launcher.
```

Preferred: keep Ultron running under the launcher, then from a Node one-liner inside the project (loopback-only mint is also available when you start without `-Tailscale` first, mint, then restart with `-Tailscale`).

5. On the phone browser open `http://100.x.x.x:3000` (the Tailscale IPv4 from `tailscale ip -4` on the PC).
6. Paste the device token once. It is stored in sessionStorage only; Ultron keeps a hash on disk.

## What the phone can do

- Chat, Vault browse, activation toggle
- Approve **reversible** write challenges
- Trigger Phase 5 PC actions after confirmation

## What stays PC-only

- Consequential writes (PC MessageBox / launcher token)
- Native interaction event POSTs
- Minting or revoking device tokens
- Voice speaker-verified write stamps
