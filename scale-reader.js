'use strict';

const {
    SerialPort,
} = require('serialport');

class ScaleReader {
    constructor(options = {}) {
        this.device =
            options.device ||
            '/dev/torrey-scale';

        this.baudRate =
            Number(
                options.baudRate ||
                9600
            );

        this.dataBits =
            Number(
                options.dataBits ||
                8
            );

        this.stopBits =
            Number(
                options.stopBits ||
                1
            );

        this.parity =
            options.parity ||
            'none';

        this.minWeightKg =
            Number(
                options.minWeightKg ||
                0
            );

        this.decimalPlaces =
            Number(
                options.decimalPlaces ||
                3
            );

        this.port = null;

        this.buffer = '';

        this.connected = false;

        this.lastReading = null;

        this.listeners = {
            weight: new Set(),
            error: new Set(),
            connected: new Set(),
            disconnected: new Set(),
        };
    }

    /*
    |--------------------------------------------------------------------------
    | Events
    |--------------------------------------------------------------------------
    */

    on(event, callback) {
        if (
            !this.listeners[event]
        ) {
            throw new Error(
                `Unknown scale event: ${event}`
            );
        }

        this.listeners[event].add(
            callback
        );

        return this;
    }

    emit(event, data) {
        const listeners =
            this.listeners[event];

        if (!listeners) {
            return;
        }

        for (
            const callback of listeners
        ) {
            try {
                callback(data);
            } catch (error) {
                console.error(
                    '[scale-reader] listener error:',
                    error
                );
            }
        }
    }

    /*
    |--------------------------------------------------------------------------
    | Start
    |--------------------------------------------------------------------------
    */

    async start() {
        if (this.port) {
            return;
        }

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
            'open',
            () => {
                this.connected = true;

                console.log(
                    `[scale-reader] Connected to ${this.device}`
                );

                this.pollInterval = setInterval(() => {
                    if (this.port && this.port.isOpen) {
                        this.port.write('P'); // Polls the scale for the current weight to display on screen
                    }
                }, 300); // Polls every 300ms for smooth real-time screen updates

                console.log(
                    `[scale-reader] Serial: ` +
                    `${this.baudRate} baud, ` +
                    `${this.dataBits}${this.parity === 'none' ? 'N' : this.parity.toUpperCase()}${this.stopBits}`
                );

                this.emit(
                    'connected'
                );
            }
        );

        this.port.on(
            'close',
            () => {
                const wasConnected =
                    this.connected;

                this.connected =
                    false;

                if (this.pollInterval) {
                    clearInterval(this.pollInterval);
                    this.pollInterval = null;
                }

                if (wasConnected) {
                    console.log(
                        '[scale-reader] Disconnected'
                    );

                    this.emit(
                        'disconnected'
                    );
                }
            }
        );

        this.port.on(
            'error',
            error => {
                console.error(
                    '[scale-reader] Serial error:',
                    error.message
                );

                this.emit(
                    'error',
                    error
                );
            }
        );

        this.port.on(
            'data',
            chunk => {
                console.log(
                    '[scale-reader] RAW CHUNK:',
                    chunk
                );

                console.log(
                    '[scale-reader] RAW HEX:',
                    chunk.toString('hex')
                );

                console.log(
                    '[scale-reader] RAW TEXT:',
                    JSON.stringify(
                        chunk.toString('ascii')
                    )
                );

                this.processData(
                    chunk
                );
            }
        );
        
        await new Promise(
            (resolve, reject) => {
                this.port.open(
                    error => {
                        if (error) {
                            reject(
                                error
                            );

                            return;
                        }

                        resolve();
                    }
                );
            }
        );
    }

    /*
    |--------------------------------------------------------------------------
    | Stop
    |--------------------------------------------------------------------------
    */

    async stop() {
        if (!this.port) {
            return;
        }

        if (
            !this.port.isOpen
        ) {
            this.port = null;

            return;
        }

        await new Promise(
            resolve => {
                this.port.close(
                    () => {
                        resolve();
                    }
                );
            }
        );

        this.port = null;
        this.connected = false;
    }

    /*
    |--------------------------------------------------------------------------
    | Serial data
    |--------------------------------------------------------------------------
    |
    | The Torrey is sending:
    |
    |     " 1.762 kg\r"
    |
    |     " 2.892 kg\r"
    |
    | We therefore process CR as the record terminator.
    |
    */

    processData(chunk) {
        const text =
            chunk.toString(
                'ascii'
            );

        console.log(
            '[scale-reader] Received:',
            JSON.stringify(text)
        );

        this.buffer += text;

        /*
         * Torrey terminates readings with CR:
         *
         *     \r
         */

        const records =
            this.buffer.split('\r');

        /*
         * Last element may be an incomplete
         * record, so keep it in the buffer.
         */

        this.buffer =
            records.pop() || '';

        for (
            const record of records
        ) {
            const line =
                record.trim();

            if (!line) {
                continue;
            }

            this.processLine(
                line
            );
        }
    }

    /*
    |--------------------------------------------------------------------------
    | Parse weight
    |--------------------------------------------------------------------------
    */

    processLine(line) {
        const originalLine = line;

        line =
            String(line)
                .trim();

        console.log(
            '[scale-reader] LINE:',
            JSON.stringify(line)
        );

        if (!line) {
            return;
        }

        // Check if the scale sent a print trigger flag (e.g., some models prefix with 'P' or send a stable indicator)
        // Adjust this condition based on your specific Torrey model's raw string output when PRINT is pressed
        const isExplicitPrint = originalLine.includes('P'); /* add any hardware flag here */;



        /*
         * Torrey L-EQ normally sends:
         *
         *     1.762 kg
         *
         * We extract the numeric portion and
         * the unit independently.
         */

        const match =
            line.match(
                /^([+-]?\d+(?:[.,]\d+)?)\s*(kg|lb|oz)?$/i
            );

        if (!match) {
            console.warn(
                '[scale-reader] Could not parse:',
                JSON.stringify(
                    originalLine
                )
            );

            return;
        }

        const value =
            Number(
                match[1]
                    .replace(
                        ',',
                        '.'
                    )
            );

        const unit =
            (
                match[2] ||
                'kg'
            ).toLowerCase();

        if (
            !Number.isFinite(value)
        ) {
            console.warn(
                '[scale-reader] Invalid numeric value:',
                match[1]
            );

            return;
        }

        let weightKg;

        switch (unit) {
            case 'kg':
                weightKg =
                    value;
                break;

            case 'lb':
                weightKg =
                    value *
                    0.45359237;
                break;

            case 'oz':
                weightKg =
                    value *
                    0.028349523125;
                break;

            default:
                console.warn(
                    '[scale-reader] Unknown unit:',
                    unit
                );

                return;
        }

        weightKg =
            Number(
                weightKg.toFixed(
                    this.decimalPlaces
                )
            );

        const weight = {
            value,

            unit,

            weightKg,

            raw:
                line,

            isPrintTriggered: isExplicitPrint,

            timestamp:
                new Date()
                    .toISOString(),
        };

        this.lastReading =
            weight;

        console.log(
            '[scale-reader] Weight:',
            `${weightKg} kg`
        );

        /*
         * Ignore zero / empty readings.
         */

        if (
            weightKg <
            this.minWeightKg
        ) {
            console.log(
                '[scale-reader] Below minimum weight, ignoring.'
            );

            return;
        }

        this.emit(
            'weight',
            weight
        );
    }

    /*
    |--------------------------------------------------------------------------
    | Status
    |--------------------------------------------------------------------------
    */

    getStatus() {
        return {
            enabled: true,

            connected:
                this.connected,

            device:
                this.device,

            baudRate:
                this.baudRate,

            lastReading:
                this.lastReading,
        };
    }
}

module.exports =
    ScaleReader;