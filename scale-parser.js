'use strict';

/**
 * Parse a weight returned by the Torrey scale.
 *
 * Examples of possible input:
 *
 *   "1.025 kg"
 *   "1.025 KG"
 *   " 1.025 kg\r"
 *   "1.025"
 *
 * Returns:
 *
 * {
 *     weight: 1.025,
 *     unit: "kg",
 *     raw: "1.025 kg"
 * }
 */
function parseWeight(input) {
    if (Buffer.isBuffer(input)) {
        input = input.toString('ascii');
    }

    const raw = String(input)
        .replace(/\0/g, '')
        .trim();

    if (!raw) {
        return null;
    }

    /*
     * Extract the first numeric value.
     *
     * Supports:
     *
     * 1
     * 1.025
     * 0.250
     * -1.025
     */
    const match = raw.match(
        /(-?\d+(?:[.,]\d+)?)/
    );

    if (!match) {
        return null;
    }

    const weight = Number(
        match[1].replace(',', '.')
    );

    if (!Number.isFinite(weight)) {
        return null;
    }

    /*
     * The L-EQ configuration we're using is kilograms.
     */
    let unit = 'kg';

    if (/\blb\b/i.test(raw)) {
        unit = 'lb';
    } else if (/\boz\b/i.test(raw)) {
        unit = 'oz';
    }

    return {
        weight,
        unit,
        raw,
    };
}

module.exports = {
    parseWeight,
};