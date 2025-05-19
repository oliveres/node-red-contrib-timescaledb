# node-red-contrib-timescaledb

Node-RED node for writing data to TimescaleDB (PostgreSQL) using a fixed schema for industry or home use. No manual SQL required.

## Features
- Supports both "industry" and "home" schemas (ISA-95 convention)
- Automatic data type detection (boolean, integer, double, text)
- Supports both "naked" and JSON object payloads
- Configurable fixed tags and measurement
- SSL connection support

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