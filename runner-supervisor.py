#!/usr/bin/env python3
import argparse
import ctypes
import errno
import json
import os
import signal
import socket
import sys
import time
from pathlib import Path

PR_SET_CHILD_SUBREAPER = 36


def set_subreaper() -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))


def reap_all(runners: dict[int, int]) -> list[tuple[int, int]]:
    exited = []
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == 0:
            break
        if pid in runners:
            exited.append((pid, status))
    return exited


def group_members(pgid: int) -> list[int]:
    members = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text()
            right = stat.rsplit(')', 1)[1].strip().split()
            state = right[0]
            proc_pgid = int(right[2])
            if proc_pgid == pgid and state != 'Z':
                members.append(int(entry.name))
        except (FileNotFoundError, PermissionError, ValueError, IndexError):
            continue
    return members


def terminate_group(pgid: int, runners: dict[int, int]) -> None:
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        reap_all(runners)
        if not group_members(pgid):
            return
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        reap_all(runners)
        if not group_members(pgid):
            return
        time.sleep(0.1)


def launch_runner(runner_path: str, cwd: str) -> int:
    ready_r, ready_w = os.pipe()
    try:
        pid = os.fork()
    except BaseException:
        os.close(ready_r)
        os.close(ready_w)
        raise
    if pid == 0:
        os.close(ready_r)
        try:
            os.setsid()
            os.write(ready_w, b'1')
            os.close(ready_w)
            os.chdir(cwd)
            os.execv('/bin/sh', ['sh', runner_path])
        except BaseException:
            try:
                os.close(ready_w)
            except OSError:
                pass
            os._exit(127)
    os.close(ready_w)
    try:
        ready = os.read(ready_r, 1)
    finally:
        os.close(ready_r)
    if ready != b'1':
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        raise RuntimeError('runner failed before process-group readiness')
    return pid


def serve(socket_path: str) -> None:
    set_subreaper()
    path = Path(socket_path)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    os.chmod(socket_path, 0o600)
    server.listen(16)
    server.settimeout(0.2)
    runners: dict[int, int] = {}
    launch_in_flight = False
    shutdown_requested = False

    def ignore_sigchld(_sig, _frame):
        return None

    def cleanup_and_exit() -> None:
        for pgid in list(runners.values()):
            try:
                terminate_group(pgid, runners)
            except BaseException:
                pass
        os._exit(0)

    def shutdown(_sig, _frame):
        # Runners are setsid()'d into their own process groups; if the
        # supervisor dies without terminating them they survive, reparent
        # to init, and run unmanaged (a relaunched supervisor starts with
        # an empty runners dict and never sees them). Kill every group on
        # SIGTERM/SIGINT so a supervisor restart cannot orphan runners.
        # launch_runner() forks and setsid()s before serve() records
        # runners[pid]; if a signal arrives in that window, defer _exit
        # until the new group is tracked.
        nonlocal shutdown_requested
        shutdown_requested = True
        if launch_in_flight:
            return
        cleanup_and_exit()

    signal.signal(signal.SIGCHLD, ignore_sigchld)
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    while True:
        try:
            conn, _ = server.accept()
        except socket.timeout:
            conn = None
        if conn is not None:
            with conn:
                try:
                    raw = b''
                    while not raw.endswith(b'\n'):
                        chunk = conn.recv(65536)
                        if not chunk:
                            break
                        raw += chunk
                    request = json.loads(raw.decode('utf-8'))
                    action = request.get('action')
                    if action == 'ping':
                        response = {'ok': True, 'pid': os.getpid(), 'subreaper': True}
                    elif action == 'launch':
                        runner_path = str(request['runnerPath'])
                        cwd = str(request['cwd'])
                        launch_in_flight = True
                        try:
                            pid = launch_runner(runner_path, cwd)
                            runners[pid] = pid
                            response = {'ok': True, 'pid': pid, 'pgid': pid, 'supervisorPid': os.getpid()}
                        finally:
                            launch_in_flight = False
                            if shutdown_requested:
                                cleanup_and_exit()
                    else:
                        response = {'ok': False, 'error': 'unknown_action'}
                except Exception as exc:
                    response = {'ok': False, 'error': f'{type(exc).__name__}:{exc}'}
                conn.sendall((json.dumps(response) + '\n').encode('utf-8'))

        for pid, _status in reap_all(runners):
            pgid = runners.pop(pid, pid)
            terminate_group(pgid, runners)
            reap_all(runners)


def client(socket_path: str, payload: dict) -> int:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(3.0)
    sock.connect(socket_path)
    sock.sendall((json.dumps(payload) + '\n').encode('utf-8'))
    raw = b''
    while not raw.endswith(b'\n'):
        chunk = sock.recv(65536)
        if not chunk:
            break
        raw += chunk
    response = json.loads(raw.decode('utf-8'))
    print(json.dumps(response))
    return 0 if response.get('ok') else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('serve')
    sub.add_parser('ping')
    launch = sub.add_parser('launch')
    launch.add_argument('runner_path')
    launch.add_argument('cwd')
    args = parser.parse_args()
    if args.command == 'serve':
        serve(args.socket)
        return 0
    if args.command == 'ping':
        return client(args.socket, {'action': 'ping'})
    return client(args.socket, {'action': 'launch', 'runnerPath': args.runner_path, 'cwd': args.cwd})


if __name__ == '__main__':
    raise SystemExit(main())
