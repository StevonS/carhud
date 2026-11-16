#!/usr/bin/env python3
"""A pretend ELM327 OBD-II adapter with a pretend car, for testing OBD mode without a car.

    python3 test/fake_elm327.py            prints the device to use, e.g. /dev/pts/3
    OBD_DEVICE=/dev/pts/3 in /etc/carhud.conf (or the environment), then restart carhud

Options: --no-car (the adapter answers but the car doesn't, like ignition off),
         --no-multi (an adapter/car that only takes one PID per request), --link /tmp/fake-obd (a fixed path)
"""
import math, os, pty, sys, time, tty, select, random

args = sys.argv[1:]
NO_CAR = '--no-car' in args
NO_MULTI = '--no-multi' in args
link = args[args.index('--link') + 1] if '--link' in args else None

SUPPORTED = [0x04, 0x05, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x1F, 0x20, 0x23, 0x24, 0x2F, 0x33, 0x40, 0x42, 0x46, 0x49, 0x5C, 0x5E]
LEN = {0x04: 1, 0x05: 1, 0x0B: 1, 0x0C: 2, 0x0D: 1, 0x0E: 1, 0x0F: 1, 0x10: 2, 0x11: 1, 0x1F: 2, 0x23: 2, 0x24: 4, 0x2F: 1, 0x33: 1, 0x42: 2, 0x46: 1, 0x49: 1, 0x5C: 1, 0x5E: 2}
RATIOS = [117, 69, 47, 36, 29, 24]
T0 = time.time()


def car(t):
    """A 30 s loop: idle, pull through the gears, cruise, brake to a stop."""
    p = t % 30
    if p < 3:
        return dict(speed=0, gear=0, pedal=0)
    if p < 15:
        q = p - 3; g = min(5, int(q / 2.4) + 1); speed = 8 + q * 9.5
        return dict(speed=speed, gear=g, pedal=95)
    if p < 24:
        return dict(speed=120 + 3 * math.sin(p), gear=6, pedal=22)
    q = (p - 24) / 6
    return dict(speed=max(0, 120 * (1 - q)), gear=max(1, 6 - int(q * 6)), pedal=0)


def value(pid, t):
    c = car(t); spd = c['speed']; g = c['gear']
    rpm = 820 + random.uniform(-15, 15) if g == 0 or spd < 3 else RATIOS[g - 1] * spd
    load = 20 + c['pedal'] * 0.7
    mapk = 35 + c['pedal'] * 1.6 if c['pedal'] > 50 else 40
    coolant = min(92, 60 + t * 0.5)
    v = {
        0x04: [int(load * 2.55)], 0x05: [int(coolant + 40)], 0x0B: [int(min(255, mapk))],
        0x0C: [int(rpm * 4) >> 8, int(rpm * 4) & 255], 0x0D: [int(spd)], 0x0E: [int((15 + 64) * 2)], 0x0F: [int(28 + 40)],
        0x10: [int(load * 3) >> 8, int(load * 3) & 255], 0x11: [int(c['pedal'] * 2.55)], 0x1F: [int(t) >> 8 & 255, int(t) & 255],
        0x23: [(1200 + int(c['pedal'] * 6)) >> 8, (1200 + int(c['pedal'] * 6)) & 255],
        0x24: [int(0.86 * 32768 if c['pedal'] > 80 else 32768) >> 8, int(0.86 * 32768 if c['pedal'] > 80 else 32768) & 255, 0x80, 0x00],
        0x2F: [int(62 * 2.55)], 0x33: [100], 0x42: [14200 >> 8, 14200 & 255], 0x46: [18 + 40], 0x49: [int(c['pedal'] * 2.55)],
        0x5C: [int(min(105, 55 + t * 0.4) + 40)], 0x5E: [int(load * 0.4 * 20) >> 8, int(load * 0.4 * 20) & 255],
    }
    return v[pid]


def bitmask(base):
    b = [0, 0, 0, 0]
    for p in SUPPORTED:
        if base < p <= base + 32:
            i = p - base - 1; b[i >> 3] |= 0x80 >> (i & 7)
    return b


def hexs(bs, spaces):
    return (' ' if spaces else '').join('%02X' % x for x in bs)


def can_format(data, spaces):
    """One answer, single or multi-frame as an ELM327 prints CAN with headers off."""
    if len(data) <= 7:
        return [hexs(data, spaces)]
    lines = ['%03X' % len(data)]
    lines.append('0:' + (' ' if spaces else '') + hexs(data[:6], spaces))
    rest = data[6:]; n = 1
    while rest:
        lines.append('%X:' % (n % 16) + (' ' if spaces else '') + hexs(rest[:7], spaces)); rest = rest[7:]; n += 1
    return lines


state = dict(echo=True, spaces=True, linefeed=True, searched=False)


def answer(cmd):
    c = cmd.upper().replace(' ', '')
    if c == '':
        return []
    if c.startswith('AT'):
        a = c[2:]
        if a == 'Z':
            state.update(echo=True, spaces=True, searched=False); time.sleep(0.3); return ['', 'ELM327 v1.5']
        if a in ('I',): return ['ELM327 v1.5']
        if a == 'E0': state['echo'] = False; return ['OK']
        if a == 'E1': state['echo'] = True; return ['OK']
        if a == 'S0': state['spaces'] = False; return ['OK']
        if a == 'S1': state['spaces'] = True; return ['OK']
        if a == 'RV': return ['14.%dV' % random.randint(0, 3)]
        if a == 'DPN': return ['A6']
        if a == 'DP': return ['AUTO, ISO 15765-4 (CAN 11/500)']
        return ['OK']
    if NO_CAR:
        time.sleep(1.0); return ['SEARCHING...', 'UNABLE TO CONNECT']
    if not c.startswith('01') or len(c) < 4:
        return ['?']
    pids = [int(c[i:i + 2], 16) for i in range(2, len(c), 2)]
    if NO_MULTI and len(pids) > 1:
        return ['?']
    pre = []
    if not state['searched']:
        state['searched'] = True; time.sleep(0.8); pre = ['SEARCHING...']
    t = time.time() - T0
    data = [0x41]
    for p in pids:
        if p % 0x20 == 0:
            data += [p] + bitmask(p)
        elif p in SUPPORTED and p in LEN:
            data += [p] + value(p, t)
    if len(data) == 1:
        return pre + ['NO DATA']
    time.sleep(0.012 + 0.006 * len(pids))      # a bus round trip
    return pre + can_format(data, state['spaces'])


def main():
    master, slave = pty.openpty()
    tty.setraw(master)
    name = os.ttyname(slave)
    if link:
        try: os.unlink(link)
        except FileNotFoundError: pass
        os.symlink(name, link); name = link + ' (' + os.ttyname(slave) + ')'
    print('fake ELM327 on', name, '| car:', 'off' if NO_CAR else 'on', '| multi-PID:', 'no' if NO_MULTI else 'yes', flush=True)
    buf = b''
    while True:
        r, _, _ = select.select([master], [], [], 1)
        if not r:
            continue
        buf += os.read(master, 1024)
        while b'\r' in buf:
            line, buf = buf.split(b'\r', 1)
            cmd = line.decode('latin1').strip()
            out = ''
            if state['echo']:
                out += cmd + '\r'
            for l in answer(cmd):
                out += l + '\r'
            out += '\r>'
            os.write(master, out.encode('latin1'))


if __name__ == '__main__':
    main()
