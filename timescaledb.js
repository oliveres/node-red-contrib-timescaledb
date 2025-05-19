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
    function TimescaleDBNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.configNode = RED.nodes.getNode(config.server);
        node.schema = config.schema || 'industrial';
        node.payloadType = config.payloadType || 'json';
        node.measurement = config.measurement;
        node.field = config.field;
        node.fixedTags = config.fixedTags || {};

        // Create a connection pool (best practice for Node-RED)
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
                // 1. Prepare tags (fixed, from msg.tags, from topic)
                let tags = {};
                if (typeof node.fixedTags === 'string') {
                    try { tags = JSON.parse(node.fixedTags); } catch {}
                } else if (typeof node.fixedTags === 'object') {
                    tags = { ...node.fixedTags };
                }
                if (msg.tags && typeof msg.tags === 'object') {
                    tags = { ...tags, ...msg.tags };
                }
                if (msg.topic) {
                    tags = { ...tags, ...parseTopicToTags(msg.topic, node.schema) };
                }

                // 2. Measurement
                let measurement = msg.measurement || node.measurement;
                if (!measurement) throw new Error('Measurement is required');

                // 3. Field
                let field = msg.field || node.field;
                if (!field && node.payloadType === 'naked') throw new Error('Field is required for naked payload');

                // 4. Prepare values
                let values = [];
                if (node.payloadType === 'naked') {
                    // Only one value, field is required
                    values.push({ field, value: msg.payload });
                } else {
                    // JSON object, each key is a field
                    if (typeof msg.payload !== 'object' || msg.payload === null) {
                        throw new Error('Payload must be an object for JSON payload type');
                    }
                    for (const [k, v] of Object.entries(msg.payload)) {
                        values.push({ field: k, value: v });
                    }
                }

                // 5. Prepare jsonb tags
                let jsonb = msg.jsonb && typeof msg.jsonb === 'object' ? msg.jsonb : {};

                // 6. Insert each value as a row
                let results = [];
                for (const v of values) {
                    const { column, value } = detectTypeAndColumn(v.value, node.schema);
                    // Prepare columns and values for SQL
                    let columns = ['time', 'measurement', 'field', column, 'unit', 'tags'];
                    let params = ['now()', '$1', '$2', '$3', '$4', '$5'];
                    let paramValues = [measurement, v.field, value, null, null];

                    // Add fixed tags columns
                    if (node.schema === 'industrial') {
                        columns.splice(1, 0, 'org', 'location', 'building', 'area', 'device');
                        params.splice(1, 0, '$6', '$7', '$8', '$9', '$10');
                        paramValues.splice(1, 0,
                            tags.org || null,
                            tags.location || null,
                            tags.building || null,
                            tags.area || null,
                            tags.device || null
                        );
                    } else {
                        columns.splice(1, 0, 'name', 'location', 'building', 'floor', 'device');
                        params.splice(1, 0, '$6', '$7', '$8', '$9', '$10');
                        paramValues.splice(1, 0,
                            tags.name || null,
                            tags.location || null,
                            tags.building || null,
                            tags.floor || null,
                            tags.device || null
                        );
                    }

                    // Add jsonb tags
                    columns.push('tags');
                    params.push('$11');
                    paramValues.push(JSON.stringify(jsonb));

                    // Build SQL
                    const sql = `INSERT INTO measurements (${columns.join(',')}) VALUES (${params.join(',')})`;
                    // Execute
                    const res = await pool.query(sql, paramValues);
                    results.push(res);
                }
                msg.result = { status: 'ok', inserted: values.length };
                send(msg);
                if (done) done();
            } catch (err) {
                node.error('TimescaleDB insert error: ' + err.message, msg);
                msg.result = { status: 'error', error: err.message };
                send(msg);
                if (done) done(err);
            }
        });

        node.on('close', function() {
            // Close the pool on node shutdown
            pool.end();
        });
    }
    RED.nodes.registerType('timescaledb', TimescaleDBNode);
}; 