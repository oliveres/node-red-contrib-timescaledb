'use strict';

module.exports = function(RED) {
    const { resolveTimestamp, mergeTags, writeMeasurements } = require('./lib/timescale');

    // Mapping keys that map a topic level directly onto a known table column.
    const KNOWN_KEYS = ['org', 'name', 'location', 'building', 'area', 'floor', 'room', 'group', 'device', 'measurement', 'field'];

    function MQTTtoTimescaleDBNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.configNode = RED.nodes.getNode(config.server);
        node.topicMapping = config.topicMapping || 'org/name/location/building/area/floor/room/group/device/measurement/field';
        node.ignoreTopic = config.ignoreTopic || false;
        node.unit = config.unit;
        node.fixedTags = config.fixedTags || {};
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
                const useTopic = !node.ignoreTopic && msg.topic;
                const mapping = (msg.mapping && typeof msg.mapping === 'string') ? msg.mapping : node.topicMapping;
                let tags = {};
                let measurement;
                let field;
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
                        } else if (KNOWN_KEYS.includes(mapKey)) {
                            if (mapKey === 'measurement') measurement = topicVal;
                            else if (mapKey === 'field') field = topicVal;
                            else tags[mapKey] = topicVal;
                        } else {
                            extraTags[mapKey] = topicVal;
                        }
                    }
                } else if (node.ignoreTopic) {
                    // Topic ignored: take tags from fixed/msg tags and the
                    // measurement/field from the message instead of the topic.
                    tags = mergeTags(node.fixedTags, msg.tags, () => node.warn('Invalid Fixed Tags JSON, ignoring'));
                    measurement = msg.measurement;
                    field = msg.field;
                } else {
                    node.error('MQTT to TimescaleDB node requires msg.topic unless ignoreTopic is set.', msg);
                    msg.result = { status: 'error', error: 'No topic provided and ignoreTopic is false.' };
                    send(msg);
                    if (done) done();
                    return;
                }
                const src = useTopic ? 'topic mapping' : 'msg';
                if (!measurement) throw new Error(`Measurement is required (from ${src}).`);
                // For JSON payloads the field comes from each object key, so a
                // field is only required for naked payloads.
                if (!field && node.payloadType === 'naked') throw new Error(`Field is required for naked payload (from ${src}).`);

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

                let jsonb = { ...extraTags };
                if (msg.jsonb && typeof msg.jsonb === 'object') {
                    jsonb = { ...jsonb, ...msg.jsonb };
                }
                const unit = msg.unit !== undefined ? msg.unit : (node.unit !== undefined ? node.unit : null);
                const time = resolveTimestamp(msg.timestamp, () => node.warn('Invalid msg.timestamp, using current time'));

                await writeMeasurements(pool, values.map(v => ({
                    time, tags, measurement, field: v.field,
                    value: v.value, unit, jsonb, schema: node.schema
                })));
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
        // The pool is owned and closed by the config node, not here.
    }
    RED.nodes.registerType('mqtt-to-timescaledb', MQTTtoTimescaleDBNode);
};
