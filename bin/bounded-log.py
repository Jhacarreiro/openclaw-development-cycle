#!/usr/bin/env python3
"""Run a command in the runner group, retaining two bounded files per stream."""
import argparse
import os
import selectors
import subprocess
import time


class RotatingLog:
    def __init__(self, path, limit):
        self.path = path
        self.limit = limit
        self.file = open(path, 'wb', buffering=0)
        self.size = 0

    def write(self, data):
        while data:
            if self.size == self.limit:
                self.file.close()
                os.replace(self.path, self.path + '.previous')
                self.file = open(self.path, 'wb', buffering=0)
                self.size = 0
            part = data[:self.limit - self.size]
            self.file.write(part)
            self.size += len(part)
            data = data[len(part):]

    def close(self):
        self.file.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stdout', required=True)
    parser.add_argument('--stderr', required=True)
    parser.add_argument('--max-bytes', type=int, default=16 * 1024 * 1024)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if args.max_bytes < 1 or not command:
        parser.error('positive max-bytes and command required')
    logs = [RotatingLog(args.stdout, args.max_bytes), RotatingLog(args.stderr, args.max_bytes)]
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, logs[0])
    selector.register(child.stderr, selectors.EVENT_READ, logs[1])
    exited_at = None
    try:
        while selector.get_map():
            for key, _ in selector.select(timeout=0.1):
                data = os.read(key.fileobj.fileno(), 65536)
                if data:
                    key.data.write(data)
                else:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
            if child.poll() is not None:
                exited_at = exited_at or time.monotonic()
                # Residual descendants can keep pipes open. Let runner cleanup
                # terminate them after draining the leader's final output.
                if time.monotonic() - exited_at > 1:
                    break
        rc = child.wait()
        return rc if rc >= 0 else 128 - rc
    finally:
        selector.close()
        child.stdout.close()
        child.stderr.close()
        for log in logs:
            log.close()


if __name__ == '__main__':
    raise SystemExit(main())
