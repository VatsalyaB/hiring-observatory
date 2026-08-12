# Dev environment setup — Docker in WSL2, no Docker Desktop

Written for this specific machine, checked 2026-08-08. Follows the approach in
[Nick Janetakis's guide](https://nickjanetakis.com/blog/install-docker-in-wsl-2-without-docker-desktop),
with deviations that the machine's hardware and a newer Ubuntu force.

> **STATUS: COMPLETE — 2026-08-09.** Every step below has been executed and verified on this
> machine. Retained as a record and as the procedure for rebuilding, not as outstanding work.
> The one remaining manual action is setting the UNIX password — see "Remaining manual step".
>
> **Verified end state:** Ubuntu 24.04.4 LTS on WSL2 (distro on `D:`), Docker Engine 29.7.2,
> Compose v5.4.0, Node v24.19.0, user `vatsalya` in the `docker` group running Docker without
> sudo, daemon auto-starting via systemd across `wsl --shutdown`, and the repo at
> `/home/vatsalya/hiring-observatory` with git history intact.

## What was actually measured on this machine

| Check | Result | Consequence |
|---|---|---|
| `HyperVRequirementVirtualizationFirmwareEnabled` | **True** | Virtualisation already enabled in BIOS. No firmware changes needed. |
| SLAT / VM Monitor Mode / DEP | All **True** | WSL2 is supported. |
| `HypervisorPresent` | False | Expected — no hypervisor features enabled yet. Not a problem. |
| WSL installed | **No** | `wsl.exe` in system32 is the Windows stub, not an installation. |
| `Microsoft-Windows-Subsystem-Linux` | disabled | Enabled by `wsl --install`. |
| `VirtualMachinePlatform` | disabled | Enabled by `wsl --install`. |
| OS | Windows 11 Home Single Language, build 26200 | Modern enough for one-command install. |
| CPU | AMD Ryzen 5 5600H (6C/12T) | Fine. |
| **RAM** | **7.4 GB** | **Tight.** WSL2 defaults to claiming ~50% of host RAM. Must be capped explicitly. |
| **Free disk** | **C: 34.4 GB · D: 209.7 GB** | **WSL installs to C: by default.** Move the distro to D:. |
| Windows Node | v24.18.0, npm 11.16.0 | Irrelevant inside WSL — Node must be installed in the distro too. |

## The three deviations from the guide

1. **Cap WSL memory.** With 7.4 GB total, an uncapped WSL2 will starve Windows once Postgres and
   n8n are both running.
2. **Move the distro to D:.** 34 GB free on C: does not leave comfortable room for a distro plus
   accumulating Docker images and volumes.
3. **Keep the repo inside the WSL filesystem, not on `/mnt/d`.** Bind mounts across the Windows
   boundary are slow and carry the permission trap documented in Task 4 of the M1 plan. Working
   inside the Linux filesystem also means local matches the production VPS, which is the whole
   reason this route was chosen over Docker Desktop.

## Steps

### 1. Install WSL2 and Ubuntu — run in an **Administrator** PowerShell

```powershell
wsl --install -d Ubuntu
```

This enables the two Windows optional features, installs WSL2 and Ubuntu, and **requires a reboot**.
After rebooting, Ubuntu launches and prompts for a UNIX username and password. These are local to
the distro and unrelated to your Windows account.

Verify afterwards:

```powershell
wsl --list --verbose
```

Expected: `Ubuntu` in state `Running` or `Stopped`, **VERSION 2**. If it reports version 1, run
`wsl --set-version Ubuntu 2`.

### 2. Cap WSL resources

Create `C:\Users\Vatsalya\.wslconfig` with:

```ini
[wsl2]
memory=4GB
processors=4
swap=2GB
```

4 GB leaves roughly 3.4 GB for Windows, which is enough for a browser and an editor. If the stack
feels starved once n8n is running, lower Windows usage before raising this — pushing it higher on a
7.4 GB machine will make Windows swap.

Apply it:

```powershell
wsl --shutdown
```

### 3. Move the distro off C:

Newer WSL supports moving in place:

```powershell
wsl --manage Ubuntu-24.04 --move D:\WSL\Ubuntu-24.04
```

Do this **immediately after install, before Docker**, while the distro is still ~1.3 GB. It takes
seconds then and a long time later.

If that subcommand is unavailable, use export/import instead:

```powershell
wsl --shutdown
wsl --export Ubuntu D:\WSL\ubuntu-backup.tar
wsl --unregister Ubuntu
wsl --import Ubuntu D:\WSL\Ubuntu D:\WSL\ubuntu-backup.tar
```

After an import the default user resets to root. Fix it by adding this to `/etc/wsl.conf` inside the
distro, then `wsl --shutdown`:

```ini
[user]
default=<your-unix-username>
```

### 4. Install Docker Engine inside Ubuntu

From an Ubuntu shell:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

Close and reopen the Ubuntu shell so the group membership takes effect, then:

```bash
docker --version && docker compose version
```

Expected: a Docker version and Compose **v2**.

The warning Docker prints about WSL is expected and can be ignored.

### 5. Start the Docker daemon — NOT NEEDED on this setup

**Skip this step.** Ubuntu 24.04 on WSL 2.7.11 ships `/etc/wsl.conf` with `[boot] systemd=true`
already set, so `systemctl is-active docker` reports `active` and the daemon restarts by itself
after `wsl --shutdown`. Verified on this machine.

The guide predates that default. Its workaround is kept below only in case a future distro or a
`--import`ed image arrives without systemd — check `systemctl is-system-running` first, and if it
answers `running`, do nothing here.

<details>
<summary>Fallback for a distro without systemd</summary>

Append to `~/.profile`:

```sh
if grep -q "\-WSL2" /proc/version > /dev/null 2>&1; then
    if service docker status 2>&1 | grep -q "is not running"; then
        wsl.exe --distribution "${WSL_DISTRO_NAME}" --user root \
            --exec /usr/sbin/service docker start > /dev/null 2>&1
    fi
fi
```

The first new shell after this hangs for a few seconds while the daemon starts; subsequent ones are
instant. Docker keeps running until Windows reboots or WSL is shut down.

</details>

Verify (this **is** required, whichever path applied):

```bash
docker run --rm hello-world
```

Expected: the "Hello from Docker!" message.

### 6. Install Node inside Ubuntu

The M1 plan's verify scripts shell out to `docker compose exec`, so they must run in the same
environment as Docker. Windows Node cannot do this.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version && npm --version
```

Expected: Node v22 or newer — the M1 plan requires `--env-file` support. Node **24** is installed
here deliberately rather than the 22 the plan's floor allows, so the distro matches the Windows
host (v24.18) and current LTS. Verified: v24.19.0, npm 11.17.0.

### 7. Put the repo in the Linux filesystem

```bash
cd ~
git clone <repo-url> hiring-observatory
cd hiring-observatory
```

If there is no remote yet, copy it across once and treat the WSL copy as canonical:

```bash
cp -r /mnt/d/"Vatsalya PC"/hiring-observatory ~/hiring-observatory
```

**Do not** work from `/mnt/d/...`. It is slow, and `pg_dump` writing to a `/mnt` bind mount is
exactly the permission failure documented in Task 4 Step 3.

You can still edit the files from Windows — VS Code's WSL extension, or the `\\wsl$\Ubuntu\home\...`
UNC path in Explorer.

### 8. Confirm you are ready for M1

```bash
docker compose version && node --version && pwd
```

Expected: Compose v2, Node 22+, and a path under `/home/`, **not** under `/mnt/`.

Then start at Task 1 of `docs/plans/2026-08-08-m1-infrastructure.md`.

## Remaining manual step — set the UNIX password

The user `vatsalya` was created with `--disabled-password`, so **`sudo` will not work until a
password is set.** This was left deliberately: passwords are the owner's to choose and should not be
scripted or stored.

Run this in any terminal and enter a password twice when prompted:

```bash
wsl -d Ubuntu-24.04 -u root passwd vatsalya
```

Nothing in M1 Tasks 1–5 needs `sudo` — Docker already works without it — so this is not blocking.
It will be needed the first time you `apt install` something.

## Where the repo lives — read this before editing anything

**Canonical: `/home/vatsalya/hiring-observatory` inside WSL.** This is the git repo of record.

A copy also exists at `D:\Vatsalya PC\hiring-observatory` from before the migration. It is **stale**
and must not be edited — changes there will be silently lost.

Reach the canonical copy from Windows via the UNC path, which is read-write:

```
\\wsl.localhost\Ubuntu-24.04\home\vatsalya\hiring-observatory
```

VS Code's WSL extension opens it natively and is the better editing route.

## Known consequences of this choice

- **Docker restarts itself.** systemd is enabled, so the daemon comes back automatically after
  `wsl --shutdown` or a Windows reboot. Verified. No manual start needed.
- `localhost` forwarding from Windows into WSL2 is native, so `http://127.0.0.1:5678` reaches n8n in
  a Windows browser without extra configuration.
- Named Docker volumes live inside the WSL virtual disk, which is why moving it to D: matters.
- **`wsl --install` is a two-stage process.** The first run installs the WSL platform and needs a
  reboot; it does **not** install a distro. After rebooting, run it again with `-d <distro>`. A
  machine that reports `Default Version: 2` but "has no installed distributions" is mid-way through
  this, not broken.
- `Microsoft-Windows-Subsystem-Linux` showing as *disabled* in the optional-features list is
  expected and harmless — that component exists only for WSL1. `VirtualMachinePlatform` is the one
  that must be enabled.
