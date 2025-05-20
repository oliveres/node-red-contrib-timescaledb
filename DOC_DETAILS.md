# node-red-contrib-timescaledb – Detailed Documentation

## Purpose
Node-RED node for writing data to TimescaleDB (PostgreSQL) using a fixed schema for industry or home use. Supports flexible topic mapping, tag handling, and automatic type detection.

---

## Node Configuration Parameters

- **Server:** PostgreSQL/TimescaleDB connection (host, port, database, user, password, SSL)
- **Schema:** Select between "industrial" and "home" (affects tag/column names)
- **Payload Type:** "naked" or "JSON object"
- **Measurement:** Measurement name (can be overridden in msg)
- **Field:** Field name (can be overridden in msg)
- **Fixed Tags:** JSON object with fixed tags (can be overridden in msg)
- **Unit:** Unit of the value (can be overridden in msg)
- **Topic mapping:** String defining how topic levels map to columns/keys (see below)
- **Ignore msg.topic:** If checked, topic is ignored

---

## Input Message Parameters (`msg`)

- **msg.payload** (required): Value(s) to write (naked or JSON object)
- **msg.topic**: Topic to map to columns/keys according to mapping (overrides everything else unless ignoreTopic is set)
- **msg.mapping**: Mapping string (same format as in node config, optional, has priority over node config)
- **msg.tags**: JSON object with tags (overrides fixedTags from node, ignored if topic is used)
- **msg.measurement**: Overrides measurement from node (ignored if topic is used)
- **msg.field**: Overrides field from node (ignored if topic is used)
- **msg.unit**: Overrides unit from node
- **msg.timestamp**: Overrides write time (otherwise current time is used)
- **msg.jsonb**: Additional tags for JSONB (merged with extra tags from topic)

---

## Value Priority

1. If topic is used (and not ignored):
   - All tags, measurement, and field are taken only from topic according to mapping.
   - Other tags from msg or node config are ignored (except JSONB, which can be merged).
2. If `msg.mapping` is present, it is used instead of node mapping.
3. If topic is not used:
   - Values from msg (`msg.tags`, `msg.measurement`, `msg.field`) are used, or from node config.
4. `msg.unit` and `msg.timestamp` always have priority over node config or current time.

---

## Topic Mapping Logic

- Mapping string (e.g. `org/location/building/area/device/measurement/field`) defines how each topic level is mapped.
- `-` means skip this level.
- Custom key (e.g. `foo`) stores the value in JSONB under this key.
- If topic is longer than mapping, the extra parts are stored in JSONB as `tag1`, `tag2`, ... (always starting from 1).
- If mapping is longer than topic, missing values are `null`.

### Example 1
- Topic: `NNSTEEL/FVE/Hall/Meters/Inverter1/Live/ActivePower`
- Mapping: `org/location/building/area/device/measurement/field`
- Result:
  - org = NNSTEEL
  - location = FVE
  - building = Hall
  - area = Meters
  - device = Inverter1
  - measurement = Live
  - field = ActivePower

### Example 2 (custom keys and overflow)
- Topic: `A/B/C/D/E/F/G/H/I`
- Mapping: `org/location/-/foo/device/-/bar/measurement/field`
- Result:
  - org = A
  - location = B
  - foo (JSONB) = D
  - device = E
  - bar (JSONB) = G
  - measurement = H
  - field = I
  - C and F are skipped, no overflow

---

## Automatic Value Type Detection

- Decimal number → `value_double`
- Boolean → `value_bool`
- Integer:
  - home: `value_int`
  - industrial: `value_bigint`
- Text → `value_text`

---

## Error Handling

- Errors are reported to the debug window and to `msg.result` with details.

---

## Usage Scenarios

### 1. Write with topic and mapping
```json
{
  "topic": "NNSTEEL/FVE/Hall/Meters/Inverter1/Live/ActivePower",
  "payload": 1275
}
```
Mapping: `org/location/building/area/device/measurement/field`

### 2. Write without topic, only with tags in msg
```json
{
  "payload": 42.5,
  "tags": { "org": "ACME", "location": "Plant1" },
  "measurement": "temperature",
  "field": "value"
}
```

### 3. Write with unit and timestamp override
```json
{
  "payload": 100,
  "unit": "kWh",
  "timestamp": "2025-05-19T10:00:00Z"
}
```

### 4. Write with mapping in msg
```json
{
  "topic": "A/B/C/D/E/F",
  "mapping": "org/location/building/area/device/field",
  "payload": 1
}
```

---

## Notes

- If payload is JSON, each key is a field, value is the measured value.
- If payload is "naked", field is determined by mapping or node config.
- If topic has more levels than mapping, the overflow goes to JSONB as `tag1`, `tag2`, ...

</rewritten_file> 