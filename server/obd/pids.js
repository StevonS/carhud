'use strict';
/**
 * Standard OBD-II service 01 PIDs that the HUD and the gauges use.
 * bytes: data bytes after the PID; decode(a, b, c, d) -> value; tier: how often it is polled
 * (1 = every round, 2 = every 3rd, 3 = every 12th).
 */
const PIDS = {
    0x04: { name: 'load', label: 'Engine load', unit: '%', bytes: 1, tier: 2, decode: (a) => a * 100 / 255 },
    0x05: { name: 'coolant', label: 'Coolant', unit: '°C', bytes: 1, tier: 3, decode: (a) => a - 40 },
    0x06: { name: 'stft', label: 'Short fuel trim B1', unit: '%', bytes: 1, tier: 3, decode: (a) => a * 100 / 128 - 100 },
    0x07: { name: 'ltft', label: 'Long fuel trim B1', unit: '%', bytes: 1, tier: 3, decode: (a) => a * 100 / 128 - 100 },
    0x0B: { name: 'map', label: 'Manifold pressure', unit: 'kPa', bytes: 1, tier: 1, decode: (a) => a },
    0x0C: { name: 'rpm', label: 'Engine speed', unit: 'rpm', bytes: 2, tier: 1, decode: (a, b) => (a * 256 + b) / 4 },
    0x0D: { name: 'speed', label: 'Vehicle speed', unit: 'km/h', bytes: 1, tier: 1, decode: (a) => a },
    0x0E: { name: 'timing', label: 'Timing advance', unit: '°', bytes: 1, tier: 2, decode: (a) => a / 2 - 64 },
    0x0F: { name: 'iat', label: 'Intake air', unit: '°C', bytes: 1, tier: 3, decode: (a) => a - 40 },
    0x10: { name: 'maf', label: 'Mass air flow', unit: 'g/s', bytes: 2, tier: 2, decode: (a, b) => (a * 256 + b) / 100 },
    0x11: { name: 'throttle', label: 'Throttle', unit: '%', bytes: 1, tier: 1, decode: (a) => a * 100 / 255 },
    0x1F: { name: 'runtime', label: 'Run time', unit: 's', bytes: 2, tier: 3, decode: (a, b) => a * 256 + b },
    0x23: { name: 'fuelRail', label: 'Fuel rail pressure', unit: 'bar', bytes: 2, tier: 2, decode: (a, b) => (a * 256 + b) * 0.1 },
    0x24: { name: 'lambda', label: 'O2 sensor 1 lambda', unit: 'λ', bytes: 4, tier: 2, decode: (a, b) => (a * 256 + b) * 2 / 65536 },
    0x2F: { name: 'fuelLevel', label: 'Fuel level', unit: '%', bytes: 1, tier: 3, decode: (a) => a * 100 / 255 },
    0x33: { name: 'baro', label: 'Barometric pressure', unit: 'kPa', bytes: 1, tier: 3, decode: (a) => a },
    0x34: { name: 'lambda34', label: 'O2 sensor 1 lambda (current)', unit: 'λ', bytes: 4, tier: 2, decode: (a, b) => (a * 256 + b) * 2 / 65536 },
    0x42: { name: 'ecuVolts', label: 'Control module voltage', unit: 'V', bytes: 2, tier: 3, decode: (a, b) => (a * 256 + b) / 1000 },
    0x44: { name: 'lambdaCmd', label: 'Commanded lambda', unit: 'λ', bytes: 2, tier: 3, decode: (a, b) => (a * 256 + b) * 2 / 65536 },
    0x46: { name: 'ambient', label: 'Ambient air', unit: '°C', bytes: 1, tier: 3, decode: (a) => a - 40 },
    0x49: { name: 'pedal', label: 'Accelerator pedal', unit: '%', bytes: 1, tier: 1, decode: (a) => a * 100 / 255 },
    0x5C: { name: 'oil', label: 'Oil temperature', unit: '°C', bytes: 1, tier: 3, decode: (a) => a - 40 },
    0x5E: { name: 'fuelRate', label: 'Fuel rate', unit: 'L/h', bytes: 2, tier: 2, decode: (a, b) => (a * 256 + b) / 20 },
    0x62: { name: 'torquePct', label: 'Actual torque', unit: '%', bytes: 1, tier: 2, decode: (a) => a - 125 },
    0x63: { name: 'torqueRef', label: 'Reference torque', unit: 'Nm', bytes: 2, tier: 3, decode: (a, b) => a * 256 + b },
    0x87: { name: 'map2', label: 'Manifold pressure (wide)', unit: 'kPa', bytes: 5, tier: 1, decode: (a, b, c) => (b * 256 + c) / 32 },
};

const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16).toUpperCase();

/** Bitmask answer to 0100/0120/... -> list of supported PIDs */
function supportedFrom(base, bytes) {
    const out = [];
    for (let i = 0; i < 32; i++) if (bytes[i >> 3] & (0x80 >> (i & 7))) out.push(base + i + 1);
    return out;
}

module.exports = { PIDS, hex2, supportedFrom };
