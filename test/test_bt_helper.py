#!/usr/bin/env python3
"""Tests the Bluetooth helper against a simulated BlueZ (python-dbusmock), no Bluetooth hardware needed.

    pip install python-dbusmock      (and python3-dbus, python3-gi)
    python3 test/test_bt_helper.py

Covers: adapter setup, pairing with the on-screen code, trusting, reconnecting, now playing, media controls,
volume, and iPhone notifications (ANCS) including a call's answer button.
"""
import json
import os
import queue
import struct
import subprocess
import sys
import threading
import time

import dbus
import dbusmock

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, '..', 'server', 'phone', 'bt_helper.py')
ADDR = 'AA:BB:CC:DD:EE:01'
DEV = '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_01'
CP_LOG = '/tmp/carhud-test-cp.jsonl'
CHAR = 'org.bluez.GattCharacteristic1'
ANCS_NS, ANCS_CP, ANCS_DS = '9fbf120d-6301-42d9-8c58-25e699a21dbd', '69d1d8f3-45e1-49a8-9821-9bbdfdaad9d9', '22eac6e9-24d6-4bb5-be44-b36ace7c7bfb'

failures = []


def check(cond, what):
    print(('  ok    ' if cond else '  FAIL  ') + what)
    if not cond:
        failures.append(what)


class Helper:
    def __init__(self, env):
        self.p = subprocess.Popen([sys.executable, '-u', HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True)
        self.q = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        self.last_state = None

    def _read(self):
        for line in self.p.stdout:
            m = json.loads(line)
            if m['t'] == 'log':
                print('        helper: ' + m['text'])
            self.q.put(m)

    def send(self, m):
        self.p.stdin.write(json.dumps(m) + '\n'); self.p.stdin.flush()

    def wait(self, pred, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = self.q.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                break
            if m['t'] == 'state':
                self.last_state = m
            if pred(m):
                return m
        return None


def main():
    dbusmock.DBusTestCase.start_session_bus()
    bus = dbusmock.DBusTestCase.get_dbus(system_bus=False)
    server, _ = dbusmock.DBusTestCase.spawn_server_template('bluez5', {}, stdout=subprocess.DEVNULL, system_bus=False)
    mock = dbus.Interface(bus.get_object('org.bluez', '/'), 'org.bluez.Mock')
    mock.AddAdapter('hci0', 'raspberrypi')
    mock.AddDevice('hci0', ADDR, "Steven's iPhone")

    env = dict(os.environ, CARHUD_BT_BUS='session', CARHUD_BT_NAME='CarHUD', CARHUD_BT_STATE='/tmp/carhud-test-bt.json', CARHUD_BT_RECONNECT='2')
    try:
        os.unlink('/tmp/carhud-test-bt.json')
    except FileNotFoundError:
        pass
    h = Helper(env)

    print('adapter')
    st = h.wait(lambda m: m['t'] == 'state' and m.get('adapter'))
    check(st is not None and st['adapter']['name'] == 'CarHUD', 'adapter renamed to CarHUD and reported')
    props = dbus.Interface(bus.get_object('org.bluez', '/org/bluez/hci0'), dbus.PROPERTIES_IFACE)
    check(bool(props.Get('org.bluez.Adapter1', 'Powered')), 'adapter powered on')
    h.send({'t': 'discoverable', 'on': True, 'seconds': 120})
    time.sleep(0.3)
    check(bool(props.Get('org.bluez.Adapter1', 'Discoverable')), 'discoverable on request')

    print('pairing')
    agent = dbus.Interface(bus.get_object(h_name(bus, h), '/carhud/agent'), 'org.bluez.Agent1')
    result = {}
    agent.RequestConfirmation(dbus.ObjectPath(DEV), dbus.UInt32(123456), reply_handler=lambda: result.update(ok=True),
                              error_handler=lambda e: result.update(err=str(e)))
    pump_until(lambda: False, 0.3)      # let the call go out
    req = h.wait(lambda m: m['t'] == 'pair-request')
    print('        desk got: %s' % req)
    check(req is not None and req['passkey'] == '123456' and 'iPhone' in req['name'], 'desk is asked to confirm code 123456 for the iPhone')
    h.send({'t': 'pair-reply', 'accept': True})
    done = h.wait(lambda m: m['t'] == 'pair-done')
    pump_until(lambda: result)
    check(done and done['ok'] and result.get('ok'), 'accepting on the desk completes the pairing')
    mock.PairDevice('hci0', ADDR)
    time.sleep(0.4)
    dprops = dbus.Interface(bus.get_object('org.bluez', DEV), dbus.PROPERTIES_IFACE)
    check(bool(dprops.Get('org.bluez.Device1', 'Trusted')), 'paired phone is trusted (reconnects by itself)')

    result.clear()
    agent.RequestConfirmation(dbus.ObjectPath(DEV), dbus.UInt32(999999), reply_handler=lambda: result.update(ok=True),
                              error_handler=lambda e: result.update(err=str(e)))
    pump_until(lambda: False, 0.3)
    h.wait(lambda m: m['t'] == 'pair-request')
    h.send({'t': 'pair-reply', 'accept': False})
    pump_until(lambda: result)
    check('err' in result and 'Rejected' in result['err'], 'declining on the desk rejects the pairing')

    print('reconnect')
    st = h.wait(lambda m: m['t'] == 'state' and any(d['connected'] for d in m['devices']), timeout=6)
    check(st is not None, 'helper reconnects to the trusted phone by itself')

    print('music')
    mock_obj = dbus.Interface(bus.get_object('org.bluez', '/'), dbusmock.MOCK_IFACE)

    def add(path, iface, props, methods):
        # what bluetoothd does for a new object: create it and announce it on the ObjectManager
        mock_obj.AddObject(path, iface, props, methods)
        mock_obj.EmitSignal('org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', 'oa{sa{sv}}',
                            [dbus.ObjectPath(path), dbus.Dictionary({iface: dbus.Dictionary(props, signature='sv')}, signature='sa{sv}')])
    player = DEV + '/player0'
    add(player, 'org.bluez.MediaPlayer1', {
        'Name': 'Spotify', 'Status': 'playing', 'Position': dbus.UInt32(42000),
        'Track': dbus.Dictionary({'Title': 'Komm, süsser Tod', 'Artist': 'Arianne', 'Album': 'EoE', 'Duration': dbus.UInt32(460000)}, signature='sv'),
        'Device': dbus.ObjectPath(DEV)}, [
        ('Play', '', '', "self.UpdateProperties('org.bluez.MediaPlayer1', {'Status': 'playing'})"),
        ('Pause', '', '', "self.UpdateProperties('org.bluez.MediaPlayer1', {'Status': 'paused'})"),
        ('Next', '', '', "self.UpdateProperties('org.bluez.MediaPlayer1', {'Track': dbus.Dictionary({'Title': 'Next song', 'Artist': 'X', 'Duration': dbus.UInt32(1000)}, signature='sv')})"),
        ('Previous', '', '', ''), ('Stop', '', '', ''),
    ])
    add(DEV + '/fd0', 'org.bluez.MediaTransport1', {'Volume': dbus.UInt16(60), 'Device': dbus.ObjectPath(DEV), 'State': 'active'}, [])
    st = h.wait(lambda m: m['t'] == 'state' and m.get('media') and m['media'].get('title'))
    check(st and st['media']['title'] == 'Komm, süsser Tod' and st['media']['app'] == 'Spotify' and st['media']['status'] == 'playing', 'now playing: title, app and status')
    check(st and st['volume'] == 60, 'volume reported')
    h.send({'t': 'media', 'action': 'toggle'})
    st = h.wait(lambda m: m['t'] == 'state' and m.get('media') and m['media']['status'] == 'paused')
    check(st is not None, 'play/pause button pauses the phone')
    h.send({'t': 'media', 'action': 'next'})
    st = h.wait(lambda m: m['t'] == 'state' and m.get('media') and m['media']['title'] == 'Next song')
    check(st is not None, 'next button skips the track')
    h.send({'t': 'volume', 'value': 100})
    time.sleep(0.3)
    tprops = dbus.Interface(bus.get_object('org.bluez', DEV + '/fd0'), dbus.PROPERTIES_IFACE)
    check(int(tprops.Get('org.bluez.MediaTransport1', 'Volume')) == 100, 'volume control sets the phone volume')

    print('iPhone notifications (ANCS)')
    try:
        os.unlink(CP_LOG)
    except FileNotFoundError:
        pass
    svc = DEV + '/service0030'
    for path, uuid, extra in [(svc + '/char0031', ANCS_NS, []), (svc + '/char0034', ANCS_CP, []), (svc + '/char0037', ANCS_DS, [])]:
        add(path, CHAR, {'UUID': uuid, 'Service': dbus.ObjectPath(svc), 'Value': dbus.Array([], signature='y'), 'Notifying': False}, [
            ('StartNotify', '', '', "self.UpdateProperties('%s', {'Notifying': dbus.Boolean(True)})" % CHAR),
            ('StopNotify', '', '', ''),
            ('WriteValue', 'aya{sv}', '', "import json; open('%s','a').write(json.dumps([int(x) for x in args[0]]) + '\\n')" % CP_LOG),
            ('ReadValue', 'a{sv}', 'ay', 'ret = dbus.Array([], signature="y")'),
        ])
    time.sleep(1.0)
    ns_props = dbus.Interface(bus.get_object('org.bluez', svc + '/char0031'), dbus.PROPERTIES_IFACE)
    check(bool(ns_props.Get(CHAR, 'Notifying')), 'subscribes to the iPhone notification source')

    def value(path, data):
        dbus.Interface(bus.get_object('org.bluez', path), dbusmock.MOCK_IFACE).EmitSignal(
            dbus.PROPERTIES_IFACE, 'PropertiesChanged', 'sa{sv}as', [CHAR, dbus.Dictionary({'Value': dbus.Array(data, signature='y')}, signature='sv'), dbus.Array([], signature='s')])

    uid = 7
    value(svc + '/char0031', list(struct.pack('<BBBBI', 0, 2 | 8 | 16, 1, 1, uid)))      # added, important, has actions, incoming call
    time.sleep(0.5)
    writes = [json.loads(l) for l in open(CP_LOG)] if os.path.exists(CP_LOG) else []
    check(writes and writes[0][:5] == [0] + list(struct.pack('<I', uid)), 'asks the iPhone for the notification details')

    def attr(i, s):
        b = s.encode()
        return struct.pack('<BH', i, len(b)) + b
    answer = struct.pack('<BI', 0, uid) + attr(0, 'com.apple.mobilephone') + attr(1, 'Mom') + attr(2, '') + attr(3, 'Incoming call') + \
        attr(5, '20261116T130500') + attr(6, 'Answer') + attr(7, 'Decline')
    value(svc + '/char0037', list(answer[:11]))          # the answer arrives in pieces
    time.sleep(0.1)
    value(svc + '/char0037', list(answer[11:]))
    n = h.wait(lambda m: m['t'] == 'notification')
    check(n and n['title'] == 'Mom' and n['category'] == 'incoming-call' and n['appName'] == 'Phone' and n['positive'] == 'Answer' and n['negative'] == 'Decline',
          'call notification: caller, app, Answer / Decline buttons (answer arrived in two pieces)')
    h.send({'t': 'notif-action', 'uid': uid, 'positive': True})
    time.sleep(0.5)
    writes = [json.loads(l) for l in open(CP_LOG)]
    check(writes[-1] == [2] + list(struct.pack('<I', uid)) + [0], 'Answer on the desk answers the call on the iPhone')

    uid2 = 8
    value(svc + '/char0031', list(struct.pack('<BBBBI', 0, 0, 4, 1, uid2)))
    time.sleep(0.3)
    answer2 = struct.pack('<BI', 0, uid2) + attr(0, 'com.example.chat') + attr(1, 'Alex') + attr(2, '') + attr(3, 'on my way') + attr(5, '') + attr(6, '') + attr(7, '')
    value(svc + '/char0037', list(answer2))
    n = h.wait(lambda m: m['t'] == 'notification' and m['uid'] == uid2)
    check(n and n['message'] == 'on my way' and n['appName'] == 'chat', 'message notification from an app it does not know yet')
    time.sleep(0.3)
    writes = [json.loads(l) for l in open(CP_LOG)]
    check(writes[-1][0] == 1 and bytes(writes[-1][1:]).startswith(b'com.example.chat\x00'), 'asks the iPhone for that app\'s name')
    value(svc + '/char0037', list(b'\x01com.example.chat\x00' + attr(0, 'ChatApp')))
    n = h.wait(lambda m: m['t'] == 'notification' and m['uid'] == uid2 and m['appName'] == 'ChatApp')
    check(n is not None, 'app name filled in from the iPhone')
    value(svc + '/char0031', list(struct.pack('<BBBBI', 2, 0, 4, 0, uid2)))
    r = h.wait(lambda m: m['t'] == 'notification-removed')
    check(r and r['uid'] == uid2, 'dismissed on the phone -> removed on the desk')

    print('forget')
    h.send({'t': 'forget', 'address': ADDR})
    st = h.wait(lambda m: m['t'] == 'state' and not m['devices'])
    check(st is not None, 'forget removes the phone')

    h.p.terminate()
    server.terminate()
    print()
    print('FAILED: %d' % len(failures) if failures else 'all passed')
    sys.exit(1 if failures else 0)


def h_name(bus, h):
    """The helper's unique bus name (it has no well-known name)."""
    dbus_obj = dbus.Interface(bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus'), 'org.freedesktop.DBus')
    for _ in range(50):
        for n in dbus_obj.ListNames():
            if n.startswith(':'):
                try:
                    if int(dbus_obj.GetConnectionUnixProcessID(n)) == h.p.pid:
                        return n
                except dbus.exceptions.DBusException:
                    pass
        time.sleep(0.1)
    raise RuntimeError('helper not on the bus')


def pump_until(cond, timeout=5):
    from gi.repository import GLib
    ctx = GLib.MainContext.default()
    end = time.time() + timeout
    while not cond() and time.time() < end:
        ctx.iteration(False)
        time.sleep(0.02)


if __name__ == '__main__':
    import dbus.mainloop.glib
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    main()
