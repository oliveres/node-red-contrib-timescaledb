'use strict';

// Self-contained test suite for node-red-contrib-timescaledb.
// Runs with plain Node, no dev dependencies: `npm test` (or `node test/test.js`).
//
// Covers the shared lib (type detection, timestamp handling, tag merging,
// the atomic multi-row insert) and both nodes via a minimal mock of the
// Node-RED runtime, so database writes are captured instead of executed.

const assert = require('assert');
const {
    detectTypeAndColumn,
    resolveTimestamp,
    mergeTags,
    writeMeasurements
} = require('../lib/timescale');

// Column order produced by writeMeasurements, as bound-parameter indices.
const COL = {
    time: 0, org: 1, name: 2, location: 3, building: 4, area: 5, floor: 6,
    room: 7, group: 8, device: 9, measurement: 10, field: 11,
    value_bool: 12, value_int: 13, value_bigint: 14, value_double: 15,
    value_text: 16, unit: 17, tags: 18
};
const COLS_PER_ROW = 19;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- Minimal Node-RED runtime mock ----------------------------------------

function makeRED() {
    const types = {};
    const instances = {};
    const RED = {
        nodes: {
            createNode(node, config) {
                node.credentials = (config && config.credentials) || {};
                node._events = {};
                node._warnings = [];
                node._errors = [];
                node._status = null;
                node.on = (ev, cb) => { node._events[ev] = cb; };
                node.warn = (m) => { node._warnings.push(m); };
                node.error = (m) => { node._errors.push(m); };
                node.status = (s) => { node._status = s; };
            },
            registerType(type, ctor) { types[type] = ctor; },
            getNode(id) { return instances[id]; }
        }
    };
    return { RED, types, instances };
}

// Build both nodes against a fresh runtime with a config node whose pool
// captures every query instead of touching a database.
function setup() {
    const { RED, types, instances } = makeRED();
    require('../timescaledb')(RED);
    require('../mqtt-to-timescaledb')(RED);

    const captured = [];
    const Config = types['timescaledb-config'];
    const config = new Config({
        host: 'h', port: 5432, database: 'd', ssl: false,
        credentials: { user: 'u', password: 'p' }
    });
    config.pool = {
        query: async (sql, params) => { captured.push({ sql, params }); },
        end: async () => {},
        on: () => {}
    };
    instances['config1'] = config;
    return { types, instances, config, captured };
}

// Drive a node's input handler and resolve with the `done` error (if any).
function feed(node, msg) {
    return new Promise((resolve) => {
        node._events.input.call(node, msg, () => {}, (err) => resolve(err));
    });
}

// --- lib: detectTypeAndColumn ---------------------------------------------

test('detect: boolean', () => {
    assert.deepStrictEqual(detectTypeAndColumn(true), { column: 'value_bool', value: true });
});
test('detect: integer defaults to bigint (industrial)', () => {
    assert.deepStrictEqual(detectTypeAndColumn(42), { column: 'value_bigint', value: 42 });
});
test('detect: integer in home schema -> value_int', () => {
    assert.deepStrictEqual(detectTypeAndColumn(42, 'home'), { column: 'value_int', value: 42 });
});
test('detect: decimal -> value_double', () => {
    assert.deepStrictEqual(detectTypeAndColumn(12.5), { column: 'value_double', value: 12.5 });
});
test('detect: numeric NaN/Infinity -> text', () => {
    assert.strictEqual(detectTypeAndColumn(NaN).column, 'value_text');
    assert.strictEqual(detectTypeAndColumn(Infinity).column, 'value_text');
});
test('detect: "true"/"false" strings -> bool', () => {
    assert.deepStrictEqual(detectTypeAndColumn(' true '), { column: 'value_bool', value: true });
    assert.deepStrictEqual(detectTypeAndColumn('false'), { column: 'value_bool', value: false });
});
test('detect: empty/whitespace string -> text (not 0)', () => {
    assert.deepStrictEqual(detectTypeAndColumn(''), { column: 'value_text', value: '' });
    assert.deepStrictEqual(detectTypeAndColumn('   '), { column: 'value_text', value: '   ' });
});
test('detect: hex/Infinity/garbage strings -> text', () => {
    assert.strictEqual(detectTypeAndColumn('0x1F').column, 'value_text');
    assert.strictEqual(detectTypeAndColumn('Infinity').column, 'value_text');
    assert.strictEqual(detectTypeAndColumn('1f').column, 'value_text');
});
test('detect: integer string keeps precision as string', () => {
    assert.deepStrictEqual(detectTypeAndColumn('9007199254740993'),
        { column: 'value_bigint', value: '9007199254740993' });
});
test('detect: decimal/exponent strings -> double number', () => {
    assert.deepStrictEqual(detectTypeAndColumn('12.5'), { column: 'value_double', value: 12.5 });
    assert.deepStrictEqual(detectTypeAndColumn('1e3'), { column: 'value_double', value: 1000 });
});

// --- lib: resolveTimestamp -------------------------------------------------

test('timestamp: falsy (0/false/""/null/undefined) -> now', () => {
    const now = 1e12;
    for (const v of [0, false, '', null, undefined]) {
        assert.ok(resolveTimestamp(v).getTime() > now, `${JSON.stringify(v)} should fall back to now`);
    }
});
test('timestamp: invalid -> now and warns', () => {
    let warned = false;
    const d = resolveTimestamp('not-a-date', () => { warned = true; });
    assert.ok(!isNaN(d.getTime()));
    assert.strictEqual(warned, true);
});
test('timestamp: ISO string parsed exactly', () => {
    assert.strictEqual(resolveTimestamp('2025-05-19T10:00:00Z').toISOString(), '2025-05-19T10:00:00.000Z');
});
test('timestamp: numeric epoch millis parsed', () => {
    assert.strictEqual(resolveTimestamp(1747648800000).getTime(), 1747648800000);
});

// --- lib: mergeTags --------------------------------------------------------

test('mergeTags: JSON string parsed', () => {
    assert.deepStrictEqual(mergeTags('{"a":1}', null), { a: 1 });
});
test('mergeTags: object passed through', () => {
    assert.deepStrictEqual(mergeTags({ a: 1 }, null), { a: 1 });
});
test('mergeTags: msg.tags overrides fixed on conflict', () => {
    assert.strictEqual(mergeTags('{"a":1}', { a: 2 }).a, 2);
});
test('mergeTags: empty string -> {} without warning', () => {
    let warned = false;
    assert.deepStrictEqual(mergeTags('', null, () => { warned = true; }), {});
    assert.strictEqual(warned, false);
});
test('mergeTags: invalid JSON warns and yields {}', () => {
    let warned = false;
    assert.deepStrictEqual(mergeTags('{bad', null, () => { warned = true; }), {});
    assert.strictEqual(warned, true);
});

// --- lib: writeMeasurements (atomic multi-row INSERT) ----------------------

test('insert: single row -> one query, value in its column, others null', async () => {
    const calls = [];
    const pool = { query: async (sql, params) => calls.push({ sql, params }) };
    await writeMeasurements(pool, [
        { time: new Date(0), measurement: 'm', field: 'f', value: 42, schema: 'industrial' }
    ]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].params.length, COLS_PER_ROW);
    assert.strictEqual(calls[0].params[COL.value_bigint], 42);
    assert.strictEqual(calls[0].params[COL.value_bool], null);
    assert.strictEqual(calls[0].params[COL.value_double], null);
});

test('insert: multi-field JSON -> ONE atomic query with mixed types', async () => {
    const calls = [];
    const pool = { query: async (sql, params) => calls.push({ sql, params }) };
    await writeMeasurements(pool, [
        { time: new Date(0), measurement: 'env', field: 'temp', value: 21.5, schema: 'home' },
        { time: new Date(0), measurement: 'env', field: 'active', value: true, schema: 'home' },
        { time: new Date(0), measurement: 'env', field: 'note', value: 'ok', schema: 'home' },
        { time: new Date(0), measurement: 'env', field: 'count', value: 5, schema: 'home' }
    ]);
    assert.strictEqual(calls.length, 1, 'must be a single atomic INSERT');
    const { sql, params } = calls[0];
    assert.strictEqual((sql.match(/\),\(/g) || []).length, 3, 'four value tuples');
    assert.strictEqual(params.length, 4 * COLS_PER_ROW);
    assert.strictEqual(params[COL.value_double], 21.5);
    assert.strictEqual(params[COLS_PER_ROW + COL.value_bool], true);
    assert.strictEqual(params[2 * COLS_PER_ROW + COL.value_text], 'ok');
    assert.strictEqual(params[3 * COLS_PER_ROW + COL.value_int], 5);
    assert.ok(/VALUES \(\$1,/.test(sql), 'placeholders start at $1');
    assert.ok(new RegExp('\\$' + (4 * COLS_PER_ROW) + '\\)$').test(sql.trim()), 'placeholders end correctly');
});

test('insert: empty row list -> no query', async () => {
    const calls = [];
    const pool = { query: async (sql, params) => calls.push({ sql, params }) };
    await writeMeasurements(pool, []);
    assert.strictEqual(calls.length, 0);
});

test('insert: only whitelisted columns are interpolated (no injection)', async () => {
    const calls = [];
    const pool = { query: async (sql, params) => calls.push({ sql, params }) };
    await writeMeasurements(pool, [
        { time: new Date(0), measurement: "m'; DROP TABLE measurements;--", field: 'f', value: 1 }
    ]);
    // The malicious measurement must travel as a bound parameter, never inline.
    assert.ok(!calls[0].sql.includes('DROP TABLE'));
    assert.strictEqual(calls[0].params[COL.measurement], "m'; DROP TABLE measurements;--");
});

// --- nodes: config + Payload + MQTT ---------------------------------------

test('config: SSL off -> ssl false; SSL on -> validates by default', () => {
    const { types } = setup();
    const Config = types['timescaledb-config'];
    assert.strictEqual(new Config({ ssl: false, credentials: {} }).getSslConfig(), false);
    assert.deepStrictEqual(new Config({ ssl: true, credentials: {} }).getSslConfig(), { rejectUnauthorized: true });
});
test('config: legacy config (no rejectUnauthorized) still validates', () => {
    const { types } = setup();
    const Config = types['timescaledb-config'];
    // Simulates an old saved config lacking the new field.
    assert.strictEqual(new Config({ ssl: true, credentials: {} }).getSslConfig().rejectUnauthorized, true);
});
test('config: explicit opt-out disables validation; CA attached when set', () => {
    const { types } = setup();
    const Config = types['timescaledb-config'];
    assert.strictEqual(new Config({ ssl: true, rejectUnauthorized: false, credentials: {} }).getSslConfig().rejectUnauthorized, false);
    assert.strictEqual(new Config({ ssl: true, ca: 'PEM', credentials: {} }).getSslConfig().ca, 'PEM');
});

test('node: missing config node -> guarded, no input handler', () => {
    const { types } = setup();
    const node = new types['timescaledb']({ server: 'nope', payloadType: 'naked' });
    assert.ok(node._errors.length >= 1);
    assert.strictEqual(node._status && node._status.fill, 'red');
    assert.ok(!node._events.input);
});

test('Payload: naked write merges fixed + msg tags, home int -> value_int', async () => {
    const { types, captured } = setup();
    const node = new types['timescaledb']({
        server: 'config1', payloadType: 'naked', measurement: 'm', field: 'f',
        schema: 'home', fixedTags: '{"org":"ACME"}'
    });
    const err = await feed(node, { payload: 7, tags: { device: 'D1' } });
    assert.strictEqual(err, undefined);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].params[COL.value_int], 7);
    assert.strictEqual(captured[0].params[COL.org], 'ACME');
    assert.strictEqual(captured[0].params[COL.device], 'D1');
});

test('MQTT: topic mapping fills tags/measurement/field; bigint string precise', async () => {
    const { types, captured } = setup();
    const node = new types['mqtt-to-timescaledb']({
        server: 'config1', payloadType: 'naked', topicMapping: 'org/location/measurement/field'
    });
    await feed(node, { topic: 'ACME/Plant1/power/active', payload: '9007199254740993' });
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].params[COL.org], 'ACME');
    assert.strictEqual(captured[0].params[COL.measurement], 'power');
    assert.strictEqual(captured[0].params[COL.field], 'active');
    assert.strictEqual(captured[0].params[COL.value_bigint], '9007199254740993');
});

test('MQTT: JSON payload writes all keys in one atomic insert, no field needed', async () => {
    const { types, captured } = setup();
    const node = new types['mqtt-to-timescaledb']({
        server: 'config1', payloadType: 'json', topicMapping: 'name/measurement'
    });
    const err = await feed(node, { topic: 'Home/env', payload: { t: 21, h: 55 } });
    assert.strictEqual(err, undefined);
    assert.strictEqual(captured.length, 1, 'one atomic INSERT for the whole message');
    assert.strictEqual((captured[0].sql.match(/\),\(/g) || []).length, 1, 'two value tuples');
});

test('MQTT: ignoreTopic uses fixed + msg tags and msg measurement/field', async () => {
    const { types, captured } = setup();
    const node = new types['mqtt-to-timescaledb']({
        server: 'config1', payloadType: 'naked', ignoreTopic: true, fixedTags: '{"org":"ACME"}'
    });
    await feed(node, { payload: 1.5, measurement: 'status', field: 'code', tags: { device: 'Pump1' } });
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].params[COL.org], 'ACME');
    assert.strictEqual(captured[0].params[COL.device], 'Pump1');
    assert.strictEqual(captured[0].params[COL.measurement], 'status');
    assert.strictEqual(captured[0].params[COL.field], 'code');
    assert.strictEqual(captured[0].params[COL.value_double], 1.5);
});

test('MQTT: no topic and ignoreTopic off -> error, no write', async () => {
    const { types, captured } = setup();
    const node = new types['mqtt-to-timescaledb']({ server: 'config1', payloadType: 'naked', ignoreTopic: false });
    await feed(node, { payload: 1 });
    assert.ok(node._errors.some(e => /requires msg\.topic/.test(e)));
    assert.strictEqual(captured.length, 0);
});

test('MQTT: naked payload without a field -> error', async () => {
    const { types, captured } = setup();
    const node = new types['mqtt-to-timescaledb']({
        server: 'config1', payloadType: 'naked', topicMapping: 'org/measurement'
    });
    const err = await feed(node, { topic: 'ACME/power', payload: 42 });
    assert.ok(err instanceof Error);
    assert.strictEqual(captured.length, 0);
});

test('node: invalid Fixed Tags JSON warns but still writes', async () => {
    const { types, captured } = setup();
    const node = new types['timescaledb']({
        server: 'config1', payloadType: 'naked', measurement: 'm', field: 'f', fixedTags: '{bad json'
    });
    await feed(node, { payload: 1 });
    assert.ok(node._warnings.some(w => /Fixed Tags/.test(w)));
    assert.strictEqual(captured.length, 1);
});

// --- runner ---------------------------------------------------------------

(async () => {
    let passed = 0;
    const failures = [];
    for (const t of tests) {
        try {
            await t.fn();
            passed++;
        } catch (err) {
            failures.push({ name: t.name, err });
        }
    }
    for (const f of failures) {
        console.error(`✗ ${f.name}`);
        console.error(`  ${f.err && f.err.message ? f.err.message : f.err}`);
    }
    console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${passed}/${tests.length} tests passed`);
    process.exit(failures.length === 0 ? 0 : 1);
})();
