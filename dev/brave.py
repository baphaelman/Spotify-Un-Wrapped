# Starting headless Brave on dev/site/.profile, for shot.py and motion_check.py.
# A run that's killed (a timeout, Ctrl-C) used to leave its Brave running, orphaned, holding the profile's
# SingletonLock; every later run's Brave then handed off to it and quit, and the script failed with
# "NameError: page". start() frees the profile first, and kills its own Brave on SIGTERM / SIGHUP too.
import json, os, signal, subprocess, time, urllib.request
from pathlib import Path

PROFILE = Path(__file__).resolve().parent / "site" / ".profile"
B = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _ppid(pid):
    out = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return int(out) if out else None


def free_profile(wait=60):
    """Clears a stale SingletonLock: its Brave gone, or orphaned by a killed run (its parent is launchd). A Brave
    another run is still using is waited for, up to `wait` seconds."""
    lock = PROFILE / "SingletonLock"
    deadline = time.time() + wait
    while os.path.lexists(lock):
        try:
            pid = int(os.readlink(lock).rsplit("-", 1)[1])  # (a symlink to "<host>-<pid>")
        except (OSError, ValueError, IndexError):
            pid = None
        if pid and _alive(pid) and _ppid(pid) == 1:
            os.kill(pid, signal.SIGTERM)  # an orphan from a killed run
            for _ in range(25):
                if not _alive(pid):
                    break
                time.sleep(0.2)
            else:
                os.kill(pid, signal.SIGKILL)
                time.sleep(0.5)
        elif pid and _alive(pid):
            if time.time() > deadline:
                raise SystemExit(f"dev/site/.profile is in use by Brave {pid} (another run?); try again when it ends")
            time.sleep(1)
            continue
        for name in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            try:
                os.unlink(PROFILE / name)
            except FileNotFoundError:
                pass


def start(args, port, timeout=30):
    """Starts Brave with `args` (beyond the profile and the DevTools port) and returns (proc, page): page is the
    DevTools target of its first tab. Raises SystemExit if no tab shows within `timeout` seconds."""
    free_profile()
    proc = subprocess.Popen([B, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--remote-debugging-port={port}",
                             "--remote-allow-origins=*", f"--user-data-dir={PROFILE}", *args], stderr=subprocess.DEVNULL)
    # (a kill of the script itself takes its Brave along: Python's finally doesn't run on SIGTERM otherwise)
    def bye(sig, _):
        proc.kill()
        raise SystemExit(128 + sig)
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, bye)
    end = time.time() + timeout
    while time.time() < end:
        if proc.poll() is not None:
            break
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
            return proc, next(t for t in tabs if t["type"] == "page")
        except Exception:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit(f"Brave showed no tab within {timeout} s" + (" (it quit: is the profile in use?)" if proc.poll() is not None else ""))
