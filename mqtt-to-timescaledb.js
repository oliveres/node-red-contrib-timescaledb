module.exports = function(RED) {
    const { Pool } = require('pg');

    function MQTTtoTimescaleDBNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.configNode = RED.nodes.getNode(config.server);
        node.topicMapping = config.topicMapping || 'org/location/building/area/floor/room/group/device/measurement/field';
        node.ignoreTopic = config.ignoreTopic || false;
        node.unit = config.unit;
        node.fixedTags = config.fixedTags || {};

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
                let useTopic = !node.ignoreTopic && msg.topic;
                let mapping = (msg.mapping && typeof msg.mapping === 'string') ? msg.mapping : node.topicMapping;
                let tags = {};
                let measurement = undefined;
                let field = undefined;
                let extraTags = {};
                if (useTopic) {
                    const topicParts = msg.topic.split('/');
                    const mappingParts = mapping.split('/');
                    let tagCounter = 1;
                    for (let i = 0; i < topicParts.length; i++) {
                        const mapKey = mappingParts[i];
                        const topicVal = topicParts[i];
                        if (mapKey === undefined) {
                            extraTags[`tag${tagCounter}`] = topicVal;
                            tagCounter++;
                        } else if (mapKey === '-') {
                            continue;
                        } else if ([
                            'org','name','location','building','area','floor','room','group','device','measurement','field'
                        ].includes(mapKey)) {
                            if (mapKey === 'measurement') measurement = topicVal;
                            else if (mapKey === 'field') field = topicVal;
                            else tags[mapKey] = topicVal;
                        } else {
                            extraTags[mapKey] = topicVal;
                        }
                    }
                } else {
                    node.error('MQTT to TimescaleDB node requires msg.topic unless ignoreTopic is set.', msg);
                    msg.result = { status: 'error', error: 'No topic provided and ignoreTopic is false.' };
                    send(msg);
                    if (done) done();
                    return;
                }
                if (!measurement) throw new Error('Measurement is required (from topic mapping).');
                if (!field) throw new Error('Field is required (from topic mapping).');
                let values = [];
                if (config.payloadType === 'naked') {
                    values.push({ field, value: msg.payload });
                } else {
                    if (typeof msg.payload !== 'object' || msg.payload === null) {
                        throw new Error('Payload must be an object for JSON payload type');
                    }
                    for (const [k, v] of Object.entries(msg.payload)) {
                        values.push({ field: k, value: v });
                    }
                }
                let jsonb = { ...extraTags };
                if (msg.jsonb && typeof msg.jsonb === 'object') {
                    jsonb = { ...jsonb, ...msg.jsonb };
                }
                let unit = msg.unit !== undefined ? msg.unit : (node.unit !== undefined ? node.unit : null);
                let ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
                for (const v of values) {
                    const { column, value } = detectTypeAndColumn(v.value);
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
                node.error('MQTT to TimescaleDB insert error: ' + err.message, msg);
                msg.result = { status: 'error', error: err.message };
                send(msg);
                if (done) done(err);
            }
        });
        node.on('close', function() {
            pool.end();
        });
    }
    function detectTypeAndColumn(value) {
        if (typeof value === 'boolean') {
            return { column: 'value_bool', value };
        } else if (typeof value === 'number') {
            if (Number.isInteger(value)) {
                return { column: 'value_bigint', value };
            } else {
                return { column: 'value_double', value };
            }
        } else if (typeof value === 'string') {
            if (value === 'true' || value === 'false') {
                return { column: 'value_bool', value: value === 'true' };
            } else if (!isNaN(Number(value))) {
                if (value.includes('.')) {
                    return { column: 'value_double', value: Number(value) };
                } else {
                    return { column: 'value_bigint', value: Number(value) };
                }
            } else {
                return { column: 'value_text', value };
            }
        } else {
            return { column: 'value_text', value: String(value) };
        }
    }
    RED.nodes.registerType('mqtt-to-timescaledb', MQTTtoTimescaleDBNode);
}; 