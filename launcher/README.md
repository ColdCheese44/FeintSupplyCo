# FeintSupplyCo Launcher

A native **Windows desktop control panel** (WPF) for the Feint Supply Co autopilot. It launches the
dashboard, the autonomous daemon, and every component, and shows live status — no terminal required.

## Install the desktop app

Run once from the project root:

```powershell
npm run install-launcher
```

That creates two Desktop + Start Menu shortcuts:
- **FeintSupplyCo** — the control panel ([`fsc-app.ps1`](fsc-app.ps1)): buttons + live status.
- **FeintSupplyCo Terminal** — opens the dashboard straight into a **chromeless app window** (FeintTrade-style), starting the server if needed ([`fsc-terminal.ps1`](fsc-terminal.ps1)).

To launch without shortcuts:

```powershell
npm run app        # control panel
npm run terminal   # dashboard as a chromeless app window
```

The dashboard itself is a dark, tabbed **operator terminal** (Overview, Listings, Costs, Heartbeat,
Orders, IGM, Ops) with a titlebar, scrolling ticker, KPI cards, and an **Ops tab** that runs
components and controls the daemon — modeled on the FeintTrade trading terminal.

## What the control panel does

- **Live status bar** — Mode (LIVE / DRY_RUN), Daemon (running/stopped), Dashboard (up/down), with a Refresh button.
- **Dashboard & Autonomy** — Open Dashboard, Start/Stop Daemon, Install/Remove Autostart.
- **Run a cycle** — Heartbeat, Order Watch, Trend Miner, Analytics, Marketing, Trademark Hunter, Cost Dashboard, IGM Status.
- **Setup & Diagnostics** — Credential Audit, Smoke Test, Preview Discord Digest, Diagnose Pinterest, Go-Live Wizard.
- **Files & Tools** — open `feintsupply.log`, the data folder, the project folder, or the classic terminal menu.

Each "run" button opens its own console window so you can watch the output. Start/Stop Daemon and the
dashboard update the status bar automatically.

## Uninstall

Delete the shortcut files:
- `%USERPROFILE%\Desktop\FeintSupplyCo.lnk`
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\FeintSupplyCo.lnk`

## Notes

- The app uses WPF built into Windows — no extra dependencies. If WPF can't load, it falls back to the
  text menu ([`fsc-menu.ps1`](fsc-menu.ps1)), which is still available via the **Terminal Menu** button.
- The shortcut runs PowerShell hidden (`-STA -WindowStyle Hidden`) so only the app window shows.
- If `fsc.ico` is missing, [`generate-icon.ps1`](generate-icon.ps1) recreates it during install.
