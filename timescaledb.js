module.exports = function(RED) {
    const { Pool } = require('pg');

    // Config node for DB connection
    function TimescaleDBConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.host = config.host;
        this.port = config.port;
        this.database = config.database;
        this.user = this.credentials.user;
        this.password = this.credentials.password;
        this.ssl = config.ssl;
    }
    RED.nodes.registerType('timescaledb-config', TimescaleDBConfigNode, {
        credentials: {
            user: { type: 'text' },
            password: { type: 'password' }
        }
    });

    // Helper: Parse topic to tags (first 5 parts)
    function parseTopicToTags(topic, schema) {
        if (!topic) return {};
        const parts = topic.split('/');
        if (schema === 'industrial') {
            return {
                org: parts[0] || undefined,
                location: parts[1] || undefined,
                building: parts[2] || undefined,
                area: parts[3] || undefined,
                device: parts[4] || undefined
            };
        } else {
            return {
                name: parts[0] || undefined,
                location: parts[1] || undefined,
                building: parts[2] || undefined,
                floor: parts[3] || undefined,
                device: parts[4] || undefined
            };
        }
    }

    // Helper: Detect value type and target column
    function detectTypeAndColumn(value, schema) {
        if (typeof value === 'boolean') {
            return { column: 'value_bool', value };
        } else if (typeof value === 'number') {
            if (Number.isInteger(value)) {
                if (schema === 'home') {
                    return { column: 'value_int', value };
                } else {
                    return { column: 'value_bigint', value };
                }
            } else {
                return { column: 'value_double', value };
            }
        } else if (typeof value === 'string') {
            // Try to parse as number or boolean
            if (value === 'true' || value === 'false') {
                return { column: 'value_bool', value: value === 'true' };
            } else if (!isNaN(Number(value))) {
                if (value.includes('.')) {
                    return { column: 'value_double', value: Number(value) };
                } else {
                    if (schema === 'home') {
                        return { column: 'value_int', value: Number(value) };
                    } else {
                        return { column: 'value_bigint', value: Number(value) };
                    }
                }
            } else {
                return { column: 'value_text', value };
            }
        } else {
            return { column: 'value_text', value: String(value) };
        }
    }

    // Main node
    function PayloadToTimescaleDBNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.configNode = RED.nodes.getNode(config.server);
        node.unit = config.unit;
        node.fixedTags = config.fixedTags || {};
        node.measurement = config.measurement;
        node.field = config.field;
        node.payloadType = config.payloadType || 'naked';

        const pool = new Pool({
            host: node.configNode.host,
            port: node.configNode.port,
            database: node.configNode.database,
            user: node.configNode.user,
            password: node.configNode.password,
            ssl: node.configNode.ssl ? { rejectUnauthorized: false } : false
        });

        node.on('input', async function(msg, send, done) {
            try {
                // Prepare tags from node or msg.tags
                let tags = {};
                if (typeof node.fixedTags === 'string') {
                    try { tags = JSON.parse(node.fixedTags); } catch {}
                } else if (typeof node.fixedTags === 'object') {
                    tags = { ...node.fixedTags };
                }
                if (msg.tags && typeof msg.tags === 'object') {
                    tags = { ...tags, ...msg.tags };
                }
                // Measurement and field
                let measurement = msg.measurement || node.measurement;
                let field = msg.field || node.field;
                if (!measurement) throw new Error('Measurement is required');
                if (!field && node.payloadType === 'naked') throw new Error('Field is required for naked payload');
                // Prepare values
                let values = [];
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
                // Prepare jsonb tags
                let jsonb = msg.jsonb && typeof msg.jsonb === 'object' ? msg.jsonb : {};
                let unit = msg.unit !== undefined ? msg.unit : (node.unit !== undefined ? node.unit : null);
                let ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
                for (const v of values) {
                    const { column, value } = detectTypeAndColumn(v.value, node.schema);
                    let columns = [];
                    let paramValues = [];
                    columns.push('time');
                    paramValues.push(ts);
                    // All possible tags in fixed order
                    columns.push('org','name','location','building','area','floor','room','group','device');
                    paramValues.push(
                        tags.org !== undefined ? tags.org : null,
                        tags.name !== undefined ? tags.name : null,
                        tags.location !== undefined ? tags.location : null,
                        tags.building !== undefined ? tags.building : null,
                        tags.area !== undefined ? tags.area : null,
                        tags.floor !== undefined ? tags.floor : null,
                        tags.room !== undefined ? tags.room : null,
                        tags.group !== undefined ? tags.group : null,
                        tags.device !== undefined ? tags.device : null
                    );
                    columns.push('measurement', 'field');
                    paramValues.push(measurement, v.field);
                    columns.push(column);
                    paramValues.push(value);
                    columns.push('unit');
                    paramValues.push(unit);
                    columns.push('tags');
                    paramValues.push(JSON.stringify(jsonb));
                    const params = [];
                    for (let i = 1; i <= paramValues.length; i++) {
                        params.push(`$${i}`);
                    }
                    // Build SQL with quoted column names
                    const sql = `INSERT INTO measurements (${columns.map(col => `"${col}"`).join(',')}) VALUES (${params.join(',')})`;
                    await pool.query(sql, paramValues);
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
        node.on('close', function() {
            pool.end();
        });
    }
    RED.nodes.registerType('timescaledb', PayloadToTimescaleDBNode);
}; 