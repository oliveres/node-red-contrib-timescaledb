# node-red-contrib-timescaledb

Node-RED node for writing data to TimescaleDB (PostgreSQL) using a fixed schema for industry or home use. No manual SQL required.

---

## Features

- Supports both "industry" and "home" schemas (ISA-95 convention)
- Automatic data type detection (boolean, integer, double, text)
- Supports both "naked" and JSON object payloads
- Flexible topic mapping to DB columns and JSONB tags
- Option to ignore topic and use only fixed tags
- Support for unit and timestamp
- Errors are reported to the debug window and `msg.result`

---

## Node Configuration

| Parameter         | Description                                                                 |
|------------------|-----------------------------------------------------------------------------|
| **Server**       | Connection to PostgreSQL/TimescaleDB (host, port, database, user, password, SSL) |
| **Schema**       | Select between "industrial" and "home" (affects tag/column names)         |
| **Payload Type** | "naked" or "JSON object"                                                  |
| **Measurement**  | Measurement name (can be overridden in msg)                                 |
| **Field**        | Field name (can be overridden in msg)                                       |
| **Fixed Tags**   | JSON object with fixed tags (can be overridden in msg)                      |
| **Unit**         | Unit of the value (can be overridden in msg)                                |
| **Topic mapping**| String defining how topic levels map to columns/keys (see below)            |
| **Ignore msg.topic** | If checked, topic is ignored                                            |

---

## Input parameters in `msg`

| Parameter         | Description                                                                 | Overrides/priority           | Note                                    |
|------------------|-----------------------------------------------------------------------------|------------------------------|------------------------------------------|
| `msg.payload`    | Value(s) to write (naked or JSON)                                           | -                            | Required                                 |
| `msg.topic`      | Topic to map to columns/keys according to mapping                           | everything else (unless ignoreTopic) | If used, has highest priority           |
| `msg.mapping`    | Mapping string (same format as in node)                                     | mapping from node            | Optional, has priority over node         |
| `msg.tags`       | JSON object with tags                                                       | fixedTags from node          | Ignored if topic is used                 |
| `msg.measurement`| Overrides measurement from node                                             | measurement from node        | Ignored if topic is used                 |
| `msg.field`      | Overrides field from node                                                   | field from node              | Ignored if topic is used                 |
| `msg.unit`       | Overrides unit from node                                                    | unit from node               |                                          |
| `msg.timestamp`  | Overrides write time                                                        | current time                 |                                          |
| `msg.jsonb`      | Additional tags for JSONB                                                   | -                            | Merged with extra tags from topic        |

---

## Value priority (what overrides what)

1. **If topic is used (and not ignored):**
   - All tags, measurement and field are taken only from topic according to mapping.
   - Other tags from msg or node config are ignored (except JSONB, which can be merged).
2. **If `msg.mapping` is present, it is used instead of node mapping.**
3. **If topic is not used:**
   - Values from msg (`msg.tags`, `msg.measurement`, `msg.field`) are used, or from node config.
4. **`msg.unit` and `msg.timestamp` always have priority over node config or current time.**

---

## Topic mapping logic

- **Mapping string** (e.g. `org/location/building/area/device/measurement/field`) defines how each topic level is mapped.
- `-` means skip this level.
- Custom key (e.g. `foo`) stores the value in JSONB under this key.
- If topic is longer than mapping, the extra parts are stored in JSONB as `tag1`, `tag2`, ... (always starting from 1).
- If mapping is longer than topic, missing values are `null`.

**Example:**
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

**Example with custom keys and overflow:**
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

## Automatic value type detection

- Decimal number → `value_double`
- Boolean → `value_bool`
- Integer:
  - home: `value_int`
  - industrial: `value_bigint`
- Text → `value_text`

---

## Error handling

- Errors are reported to the debug window and to `msg.result` with details.

---

## Usage examples

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

## Database schema
See [database-schema.mdc](./database-schema.mdc) for details.

## Example flow
```
[
    {
        "id": "example-timescaledb-node",
        "type": "timescaledb",
        "z": "flow-id",
        "name": "Write to TimescaleDB",
        "server": "timescaledb-config",
        "schema": "industrial",
        "payloadType": "json",
        "measurement": "temperature",
        "field": "value",
        "tags": {
            "org": "ACME",
            "location": "Plant1",
            "building": "A",
            "area": "Zone1",
            "device": "Sensor42"
        },
        "x": 300,
        "y": 200,
        "wires": [[]]
    }
]
```

## License
MIT 