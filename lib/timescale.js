'use strict';

// Shared helpers for the TimescaleDB nodes. Keeping this logic in one place
// avoids the previous duplication of detectTypeAndColumn between the two node
// implementations.

// Matches a plain decimal numeric literal: optional sign, integer and/or
// fractional part, optional exponent. Intentionally rejects '', whitespace,
// hex ('0x1F'), 'Infinity'/'NaN' and other inputs that Number() would happily
// coerce into a surprising number.
const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Tag columns of the measurements table, in INSERT order.
const TAG_COLUMNS = ['org', 'name', 'location', 'building', 'area', 'floor', 'room', 'group', 'device'];

// Decide the target column and the value to store for a measurement value.
// `schema` selects the integer column: 'home' -> value_int, anything else
// (default, i.e. 'industrial') -> value_bigint.
function detectTypeAndColumn(value, schema) {
    const intColumn = schema === 'home' ? 'value_int' : 'value_bigint';

    if (typeof value === 'boolean') {
        return { column: 'value_bool', value };
    }

    if (typeof value === 'number') {
        // NaN / +-Infinity have no valid numeric column -> store as text.
        if (!Number.isFinite(value)) {
            return { column: 'value_text', value: String(value) };
        }
        if (Number.isInteger(value)) {
            return { column: intColumn, value };
        }
        return { column: 'value_double', value };
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === 'true' || trimmed === 'false') {
            return { column: 'value_bool', value: trimmed === 'true' };
        }
        // Only treat as numeric when it is a genuine decimal literal. This
        // guards against Number('') === 0, Number('  ') === 0, '0x1F' === 31,
        // 'Infinity', etc. being silently stored as numbers.
        if (trimmed !== '' && NUMERIC_RE.test(trimmed)) {
            if (trimmed.includes('.') || /[eE]/.test(trimmed)) {
                return { column: 'value_double', value: Number(trimmed) };
            }
            // Integer literal: keep it as a string so large integers are not
            // rounded by a lossy JS Number on the way to a BIGINT column.
            return { column: intColumn, value: trimmed };
        }
        return { column: 'value_text', value };
    }

    // null, undefined, objects, ...
    return { column: 'value_text', value: String(value) };
}

// Resolve a write timestamp. Missing/empty -> now(). A provided but
// unparseable value -> now(), and `onInvalid` (if given) is invoked so the
// caller can warn the user.
function resolveTimestamp(value, onInvalid) {
    if (value === undefined || value === null || value === '') {
        return new Date();
    }
    const d = new Date(value);
    if (isNaN(d.getTime())) {
        if (typeof onInvalid === 'function') onInvalid();
        return new Date();
    }
    return d;
}

// Build and execute a single-row INSERT into the measurements table.
// `row` = { time, tags, measurement, field, value, unit, jsonb, schema }.
// All values are passed as bound parameters; only the (whitelisted) value
// column name is interpolated, so this is not an injection vector.
async function writeMeasurement(pool, row) {
    const { time, tags = {}, measurement, field, value, unit, jsonb = {}, schema } = row;
    const { column, value: dbValue } = detectTypeAndColumn(value, schema);

    const columns = ['time', ...TAG_COLUMNS, 'measurement', 'field', column, 'unit', 'tags'];
    const paramValues = [
        time,
        ...TAG_COLUMNS.map(t => (tags[t] !== undefined && tags[t] !== null ? tags[t] : null)),
        measurement,
        field,
        dbValue,
        unit !== undefined ? unit : null,
        JSON.stringify(jsonb)
    ];

    const placeholders = paramValues.map((_, i) => `$${i + 1}`).join(',');
    const cols = columns.map(c => `"${c}"`).join(',');
    const sql = `INSERT INTO measurements (${cols}) VALUES (${placeholders})`;
    await pool.query(sql, paramValues);
}

module.exports = { detectTypeAndColumn, resolveTimestamp, writeMeasurement, TAG_COLUMNS };
