'use strict';

module.exports = function(RED) {
    const { Pool } = require('pg');
    const { resolveTimestamp, mergeTags, writeMeasurement } = require('./lib/timescale');

    // Config node for DB connection. Owns a single shared connection pool that
    // is reused by every node referencing this configuration.
    function TimescaleDBConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.host = config.host;
        node.port = config.port;
        node.database = config.database;
        node.user = node.credentials.user;
        node.password = node.credentials.password;
        node.ssl = config.ssl;
        node.rejectUnauthorized = config.rejectUnauthorized;
        node.ca = (config.ca && config.ca.trim()) ? config.ca : undefined;

        // Build the `ssl` option for pg.Pool. Returns false when SSL is off;
        // otherwise the server certificate is validated by default and can only
        // be disabled by an explicit opt-out. Closes the previous MITM hole
        // where rejectUnauthorized was hard-coded to false.
        node.getSslConfig = function() {
            if (!node.ssl) return false;
            const ssl = { rejectUnauthorized: node.rejectUnauthorized !== false };
            if (node.ca) ssl.ca = node.ca;
            return ssl;
        };

        node.pool = new Pool({
            host: node.host,
            port: node.port,
            database: node.database,
            user: node.user,
            password: node.password,
            ssl: node.getSslConfig()
        });
        // Without an error listener a dropped idle client would crash Node-RED.
        node.pool.on('error', function(err) {
            node.error('TimescaleDB pool error: ' + err.message);
        });

        node.on('close', function(done) {
            node.pool.end().then(() => done()).catch(() => done());
        });
    }
    RED.nodes.registerType('timescaledb-config', TimescaleDBConfigNode, {
        credentials: {
            user: { type: 'text' },
            password: { type: 'password' }
        }
    });

    // Payload to TimescaleDB: writes naked or JSON object payloads.
    function PayloadToTimescaleDBNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.configNode = RED.nodes.getNode(config.server);
        node.unit = config.unit;
        node.fixedTags = config.fixedTags || {};
        node.measurement = config.measurement;
        node.field = config.field;
        node.payloadType = config.payloadType || 'naked';
        node.schema = config.schema || 'industrial';

        // Without a valid config node there is no pool to write to.
        if (!node.configNode || !node.configNode.pool) {
            node.error('No TimescaleDB server configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no server config' });
            return;
        }
        const pool = node.configNode.pool;

        node.on('input', async function(msg, send, done) {
            try {
                // Tags: node fixed tags (JSON string or object) merged with msg.tags
                const tags = mergeTags(node.fixedTags, msg.tags, () => node.warn('Invalid Fixed Tags JSON, ignoring'));

                const measurement = msg.measurement || node.measurement;
                const field = msg.field || node.field;
                if (!measurement) throw new Error('Measurement is required');
                if (!field && node.payloadType === 'naked') throw new Error('Field is required for naked payload');

                // One row per value
                const values = [];
                if (node.payloadType === 'naked') {
                    values.push({ field, value: msg.payload });
                } else {
                    if (typeof msg.payload !== 'object' || msg.payload === null) {
                        throw new Error('Payload must be an object for JSON payload type');
                    }
                    for (const [k, v] of Object.entries(msg.payload)) {
                        values.push({ field: k, value: v });
                    }
                }

                const jsonb = msg.jsonb && typeof msg.jsonb === 'object' ? msg.jsonb : {};
                const unit = msg.unit !== undefined ? msg.unit : (node.unit !== undefined ? node.unit : null);
                const time = resolveTimestamp(msg.timestamp, () => node.warn('Invalid msg.timestamp, using current time'));

                for (const v of values) {
                    await writeMeasurement(pool, {
                        time, tags, measurement, field: v.field,
                        value: v.value, unit, jsonb, schema: node.schema
                    });
                }
                msg.result = { status: 'ok', inserted: values.length };
                send(msg);
                if (done) done();
            } catch (err) {
                node.error('Payload to TimescaleDB insert error: ' + err.message, msg);
                msg.result = { status: 'error', error: err.message };
                send(msg);
                if (done) done(err);
            }
        });
        // The pool is owned and closed by the config node, not here.
    }
    RED.nodes.registerType('timescaledb', PayloadToTimescaleDBNode);
};
