'use strict';

const { SerialPort } = require('serialport');

class TorreyScale {
    constructor(options = {}) {
        this.device =
            options.device ||
            process.env.SCALE_DEVICE ||
            '/dev/torrey-scale';

        this.baudRate =
            Number(
                options.baudRate ||
                process.env.SCALE_BAUDRATE ||
                9600
            );

        this.dataBits =
            Number(
                options.dataBits ||
                process.env.SCALE_DATA_BITS ||
                8
            );

        this.stopBits =
            Number(
                options.stopBits ||
                process.env.SCALE_STOP_BITS ||
                1
            );

        this.parity =
            options.parity ||
            process.env.SCALE_PARITY ||
            'none';

        this.readTimeout =
            Number(
                options.readTimeout ||
                process.env.SCALE_READ_TIMEOUT ||
                1000
            );

        this.port = null;

        this.buffer = '';

        this.started = false;

        this.listeners = new Set();

        this.lastWeight = null;

        this.lastWeightAt = 0;

        this.debounceMs =
            Number(
                options.debounceMs ||
                process.env.SCALE_DEBOUNCE_MS ||
                1000
            );
    }

    onWeight(callback) {
        if (typeof callback !== 'function') {
            throw new TypeError(
                'Scale listener must be a function'
            );
        }

        this.listeners.add(callback);

        return () => {
            this.listeners.delete(callback);
        };
    }

    emitWeight(weight) {
        for (const listener of this.listeners) {
            try {
                listener(weight);
            } catch (error) {
                console.error(
                    '[TORREY] Weight listener error:',
                    error
                );
            }
        }
    }

    parseLine(line) {
        const value = String(line)
            .trim();

        if (!value) {
            return null;
        }

        /*
         * Expected Torrey output:
         *
         *   1.762 kg
         *   2.892 kg
         *
         * Allow optional leading sign and decimal value.
         */

        const match = value.match(
            /^([+-]?\d+(?:\.\d+)?)\s*(kg|lb|oz)$/i
        );

        if (!match) {
            console.warn(
                '[TORREY] Ignoring unknown data:',
                JSON.stringify(value)
            );

            return null;
        }

        const numericValue =
            Number(match[1]);

        const unit =
            match[2].toLowerCase();

        if (!Number.isFinite(numericValue)) {
            return null;
        }

        return {
            weight: numericValue,
            unit,
            raw: value,
            timestamp: new Date().toISOString(),
        };
    }

    handleData(chunk) {
        this.buffer +=
            chunk.toString('ascii');

        /*
         * Torrey terminates records with CR.
         *
         * Example:
         *
         * " 1.762 kg\r"
         */

        const records =
            this.buffer.split('\r');

        /*
         * Keep incomplete record.
         */
        this.buffer =
            records.pop() || '';

        for (const record of records) {
            const parsed =
                this.parseLine(record);

            if (!parsed) {
                continue;
            }

            const now =
                Date.now();

            /*
             * Ignore duplicate records arriving
             * too quickly.
             */
            if (
                this.lastWeight &&
                this.lastWeight.weight === parsed.weight &&
                this.lastWeight.unit === parsed.unit &&
                now - this.lastWeightAt <
                    this.debounceMs
            ) {
                continue;
            }

            this.lastWeight =
                parsed;

            this.lastWeightAt =
                now;

            console.log(
                `[TORREY] Weight: ${parsed.weight.toFixed(3)} ${parsed.unit}`
            );

            this.emitWeight(parsed);
        }
    }

    async start() {
        if (this.started) {
            return;
        }

        console.log(
            `[TORREY] Opening ${this.device}`
        );

        this.port =
            new SerialPort({
                path: this.device,

                baudRate:
                    this.baudRate,

                dataBits:
                    this.dataBits,

                stopBits:
                    this.stopBits,

                parity:
                    this.parity,

                autoOpen: false,
            });

        this.port.on(
            'data',
            (data) => {
                this.handleData(data);
            }
        );

        this.port.on(
            'error',
            (error) => {
                console.error(
                    '[TORREY] Serial error:',
                    error.message
                );
            }
        );

        this.port.on(
            'close',
            () => {
                console.warn(
                    '[TORREY] Serial connection closed'
                );

                this.started = false;
            }
        );

        await new Promise(
            (resolve, reject) => {
                this.port.open(
                    (error) => {
                        if (error) {
                            reject(error);
                            return;
                        }

                        resolve();
                    }
                );
            }
        );

        this.started = true;

        console.log(
            `[TORREY] Connected to ${this.device}`
        );

        console.log(
            `[TORREY] ${this.baudRate} baud, ${this.dataBits} data bits, ${this.stopBits} stop bits, ${this.parity} parity`
        );

        console.log(
            '[TORREY] Waiting for PRINT...'
        );
    }

    async stop() {
        if (!this.port) {
            return;
        }

        if (
            this.port.isOpen
        ) {
            await new Promise(
                (resolve) => {
                    this.port.close(
                        () => resolve()
                    );
                }
            );
        }

        this.port = null;

        this.started = false;
    }
}

module.exports = TorreyScale;