# Fake serial board on a pseudo-terminal, for end-to-end tests.
# Prints its device path, then sends "tick N" every 200 ms (not with
# --silent) and answers each received line with "ECHO:<line>".
import os
import select
import sys
import time

silent = "--silent" in sys.argv
master, slave = os.openpty()
print(os.ttyname(slave), flush=True)

buf = b""
n = 0
last = 0.0
while True:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            buf += os.read(master, 1024)
        except OSError:
            buf = b""
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            os.write(master, b"ECHO:" + line.strip() + b"\r\n")
    if not silent and time.time() - last > 0.2:
        last = time.time()
        n += 1
        try:
            os.write(master, f"tick {n}\r\n".encode())
        except OSError:
            pass
    if os.getppid() == 1:  # parent test process is gone
        sys.exit(0)
